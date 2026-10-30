"""Local files during development; private S3 objects in production."""
import os
from functools import lru_cache
from uuid import uuid4

from fastapi import HTTPException
from fastapi.responses import FileResponse, RedirectResponse, Response
from db import UPLOADS

BUCKET = os.getenv('CASHBOOK_S3_BUCKET', '')
MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024


@lru_cache
def s3():
    import boto3
    return boto3.client('s3', region_name=os.environ['CASHBOOK_AWS_REGION'])


def save(content, filename, kind, content_type):
    if not BUCKET:
        (UPLOADS / filename).write_bytes(content)
        return filename
    folder = 'images' if kind == 'image' else 'voice_notes'
    prefix = os.getenv('CASHBOOK_S3_PREFIX', 'attatchments').strip('/')
    key = '/'.join(filter(None, [prefix, folder, f'{uuid4().hex}-{filename}']))
    s3().put_object(Bucket=BUCKET, Key=key, Body=content, ContentType=content_type)
    return key


def remove(key):
    if BUCKET:
        s3().delete_object(Bucket=BUCKET, Key=key)
    else:
        (UPLOADS / key).unlink(missing_ok=True)


def response(row, export=False):
    if BUCKET:
        if export:
            from botocore.exceptions import ClientError
            try:
                body = s3().get_object(Bucket=BUCKET, Key=row['attachment_url'])['Body']
                try:
                    content = body.read(MAX_ATTACHMENT_BYTES + 1)
                finally:
                    body.close()
            except ClientError as error:
                missing = error.response.get('Error', {}).get('Code') in ('NoSuchKey', '404')
                raise HTTPException(404 if missing else 502, 'Attachment file is missing.' if missing else 'Could not load attachment from storage.') from error
            if len(content) > MAX_ATTACHMENT_BYTES:
                raise HTTPException(413, 'This attachment is too large to export.')
            return Response(content, media_type=row['content_type'], headers={'Cache-Control': 'no-store'})
        url = s3().generate_presigned_url('get_object', Params={
            'Bucket': BUCKET, 'Key': row['attachment_url'],
            'ResponseContentType': row['content_type'],
        }, ExpiresIn=60)
        return RedirectResponse(url, headers={'Cache-Control': 'no-store'})
    return FileResponse(UPLOADS / row['attachment_url'], media_type=row['content_type'],
                        filename=row['original_name'], content_disposition_type='inline')
