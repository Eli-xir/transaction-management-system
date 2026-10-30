"""Attachment transport and access checks; files remain in private storage."""
import base64
import logging
from pathlib import Path
from typing import Annotated, Literal

from botocore.exceptions import BotoCoreError, ClientError
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from api_dependencies import Actor, DB
from db import UPLOADS
from models import AttachmentExport, RecordId
from service import attachment, require, user_permissions
import storage

router = APIRouter(prefix='/api/attachments', tags=['Attachments'])
logger = logging.getLogger(__name__)
MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024
MAX_EXPORT_BYTES = 50 * 1024 * 1024
STORAGE_ERRORS = (BotoCoreError, ClientError, OSError)


class AttachmentResponse(BaseModel):
    id: str
    kind: Literal['image', 'voice']
    name: str
    url: str


MEDIA_TYPES = {
    'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png', 'gif': 'image/gif',
    'webp': 'image/webp', 'bmp': 'image/bmp', 'heic': 'image/heic', 'heif': 'image/heif', 'avif': 'image/avif',
    'mp3': 'audio/mpeg', 'm4a': 'audio/mp4', 'mp4': 'audio/mp4', 'aac': 'audio/aac',
    'wav': 'audio/wav', 'ogg': 'audio/ogg', 'webm': 'audio/webm', 'flac': 'audio/flac',
}


def matches_file(data, ext):
    if ext in ('jpg', 'jpeg'): return data.startswith(b'\xff\xd8\xff')
    if ext == 'png': return data.startswith(b'\x89PNG\r\n\x1a\n')
    if ext == 'gif': return data.startswith((b'GIF87a', b'GIF89a'))
    if ext in ('webp', 'wav'): return data[:4] == b'RIFF' and data[8:12] == (b'WEBP' if ext == 'webp' else b'WAVE')
    if ext == 'bmp': return data.startswith(b'BM')
    if ext in ('heic', 'heif', 'avif', 'm4a', 'mp4'): return data[4:8] == b'ftyp'
    if ext == 'ogg': return data.startswith(b'OggS')
    if ext == 'webm': return data.startswith(b'\x1aE\xdf\xa3')
    if ext == 'flac': return data.startswith(b'fLaC')
    if ext in ('mp3', 'aac'): return data.startswith(b'ID3') or (len(data) > 1 and data[0] == 255 and data[1] & 224 == 224)
    return False


def storage_response(row, *, export=False):
    try:
        return storage.response(row, export=export)
    except STORAGE_ERRORS as error:
        logger.warning('Attachment storage read failed', exc_info=True)
        raise HTTPException(503, 'Attachments are temporarily unavailable. Please try again in a moment.') from error


@router.post('', response_model=AttachmentResponse, summary='Upload an image or voice attachment')
def upload(db: DB, actor: Actor, file: Annotated[UploadFile, File()], kind: Annotated[Literal['image', 'voice'], Form()]):
    name = (file.filename or 'attachment').replace('\\', '/').split('/')[-1][:255]
    ext = Path(name).suffix.lower().lstrip('.')
    type_id = 1 if kind == 'image' else 2
    extension = db.execute('SELECT extension_id FROM allowed_extensions WHERE attachment_type_id=%s AND extension_name=%s', (type_id, ext)).fetchone()
    require(extension and ext in MEDIA_TYPES, 'Unsupported file type. Choose an image or audio file.')
    try:
        content = file.file.read(MAX_ATTACHMENT_BYTES + 1)
    except OSError as error:
        raise HTTPException(400, 'This file could not be read. Please select it again.') from error
    require(0 < len(content) <= MAX_ATTACHMENT_BYTES, 'Each attachment must be between 1 byte and 5 MB.')
    require(matches_file(content, ext), 'The file contents do not match its image/audio extension.')
    row = db.execute('''INSERT INTO attachments(attachment_type_id,extension_id,attachment_url,original_name,content_type,uploaded_by)
        VALUES (%s,%s,'',%s,%s,%s) RETURNING *''', (type_id, extension['extension_id'], name, MEDIA_TYPES[ext], actor['user_id'])).fetchone()
    filename = f"{row['attachment_id']}.{ext}"
    try:
        key = storage.save(content, filename, kind, MEDIA_TYPES[ext])
    except STORAGE_ERRORS as error:
        logger.warning('Attachment storage write failed', exc_info=True)
        raise HTTPException(503, 'We couldn’t save your file. Please try again in a moment.') from error
    try:
        db.execute('UPDATE attachments SET attachment_url=%s WHERE attachment_id=%s', (key, row['attachment_id']))
    except Exception:
        # A cleanup failure must not replace the original database error.
        try:
            storage.remove(key)
        except Exception:
            logger.exception('Could not remove attachment after failed database transaction')
        raise
    # A connection failure during COMMIT can have an unknown outcome. Retain
    # the immutable file: removing it could break a row that actually committed.
    db.commit()
    return attachment(row)


@router.get('/{attachment_id}', summary='View or download an authorized attachment')
def download_attachment(attachment_id: RecordId, db: DB, actor: Actor, export: bool = False):
    row = db.execute('SELECT * FROM attachments WHERE attachment_id=%s', (attachment_id,)).fetchone()
    require(row, 'Attachment not found.', 404)
    if actor['user_role_id'] != 1:
        allowed = db.execute('''SELECT 1 FROM heads h
            WHERE h.attachment_id=%s AND h.is_active AND NOT h.is_deleted AND h.head_id=ANY(%s)
            UNION ALL SELECT 1 FROM transactions t JOIN transaction_version_attachments va ON va.version_id=t.current_version_id
            WHERE va.attachment_id=%s AND t.user_id=%s AND t.created_by_user_id<>t.user_id AND t.is_active
            UNION ALL SELECT 1 FROM attachments a WHERE a.attachment_id=%s AND a.uploaded_by=%s AND NOT a.is_submitted
            AND NOT EXISTS(SELECT 1 FROM transaction_version_attachments va WHERE va.attachment_id=a.attachment_id)
            AND NOT EXISTS(SELECT 1 FROM heads h WHERE h.attachment_id=a.attachment_id) LIMIT 1''',
            (attachment_id, list(user_permissions(db, actor['user_id'])), attachment_id, actor['user_id'], attachment_id, actor['user_id'])).fetchone()
        require(allowed, 'Attachment not found.', 404)
    if not storage.BUCKET:
        require((UPLOADS / row['attachment_url']).is_file(), 'Attachment file is missing.', 404)
    return storage_response(row, export=export)


@router.post('/export', response_model=dict[str, str], summary='Export image bytes for a report')
def export_attachments(value: AttachmentExport, db: DB, actor: Actor):
    require(actor['user_role_id'] == 1, 'Administrator access required.', 403)
    ids = list(dict.fromkeys(value.ids))
    rows = db.execute('SELECT * FROM attachments WHERE attachment_id=ANY(%s)', (ids,)).fetchall()
    require(len(rows) == len(ids), 'An attachment is missing. Refresh and retry.', 404)
    require(all(row['attachment_type_id'] == 1 for row in rows), 'Only images can be exported here.')
    images = {}
    total_bytes = 0
    for row in rows:
        result = storage_response(row, export=True)
        if hasattr(result, 'path'):
            try:
                with Path(result.path).open('rb') as source:
                    content = source.read(MAX_ATTACHMENT_BYTES + 1)
            except FileNotFoundError as error:
                raise HTTPException(404, 'Attachment file is missing.') from error
            except OSError as error:
                logger.warning('Attachment file read failed', exc_info=True)
                raise HTTPException(503, 'Attachments are temporarily unavailable. Please try again in a moment.') from error
        else:
            content = result.body
        require(len(content) <= MAX_ATTACHMENT_BYTES, 'This attachment is too large to export.', 413)
        total_bytes += len(content)
        require(total_bytes <= MAX_EXPORT_BYTES, 'These attachments are too large to export together. Select fewer entries and try again.', 413)
        images[str(row['attachment_id'])] = f"data:{row['content_type']};base64,{base64.b64encode(content).decode('ascii')}"
    return images
