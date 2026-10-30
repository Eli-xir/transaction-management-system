import io
import unittest
from unittest.mock import Mock, patch

import psycopg
from botocore.exceptions import EndpointConnectionError
from fastapi import HTTPException, UploadFile

from attachments import MAX_ATTACHMENT_BYTES, download_attachment, export_attachments, upload
from models import AttachmentExport
from fastapi.responses import Response


class AttachmentRouteTests(unittest.TestCase):
    def file(self, content=b'\xff\xd8\xffreceipt', name='receipt.jpg'):
        return UploadFile(filename=name, file=io.BytesIO(content))

    def db(self):
        db = Mock()
        db.execute.return_value.fetchone.side_effect = [
            {'extension_id': 1},
            {'attachment_id': 42, 'attachment_type_id': 1, 'original_name': 'receipt.jpg'},
        ]
        return db

    def test_upload_keeps_file_bytes_and_commits_metadata(self):
        db = self.db()
        with patch('attachments.storage.save', return_value='42.jpg') as save:
            result = upload(db, {'user_id': 'u'}, self.file(), 'image')
        save.assert_called_once_with(b'\xff\xd8\xffreceipt', '42.jpg', 'image', 'image/jpeg')
        db.commit.assert_called_once()
        self.assertEqual(result, {'id': '42', 'kind': 'image', 'name': 'receipt.jpg', 'url': '/api/attachments/42'})

    def test_storage_failure_is_safe_and_does_not_commit(self):
        db = self.db()
        with patch('attachments.storage.save', side_effect=EndpointConnectionError(endpoint_url='private-storage')), \
                self.assertLogs('attachments', level='WARNING'):
            with self.assertRaises(HTTPException) as caught:
                upload(db, {'user_id': 'u'}, self.file(), 'image')
        self.assertEqual(caught.exception.status_code, 503)
        self.assertNotIn('private-storage', caught.exception.detail)
        db.commit.assert_not_called()

    def test_database_failure_preserved_even_if_storage_cleanup_fails(self):
        db = self.db()
        failure = psycopg.OperationalError('connection lost')
        def fail_update(sql, params):
            if sql.startswith('UPDATE attachments'):
                raise failure
            return db.execute.return_value
        db.execute.side_effect = fail_update
        with patch('attachments.storage.save', return_value='42.jpg'), \
                patch('attachments.storage.remove', side_effect=OSError('cleanup failed')), \
                self.assertLogs('attachments', level='ERROR'):
            with self.assertRaises(psycopg.OperationalError) as caught:
                upload(db, {'user_id': 'u'}, self.file(), 'image')
        self.assertIs(caught.exception, failure)

    def test_unknown_commit_outcome_keeps_file_in_case_metadata_was_committed(self):
        db = self.db()
        failure = psycopg.OperationalError('connection lost during commit')
        db.commit.side_effect = failure
        with patch('attachments.storage.save', return_value='42.jpg'), patch('attachments.storage.remove') as remove:
            with self.assertRaises(psycopg.OperationalError) as caught:
                upload(db, {'user_id': 'u'}, self.file(), 'image')
        self.assertIs(caught.exception, failure)
        remove.assert_not_called()

    def test_invalid_size_and_content_never_reach_storage(self):
        for content in [b'', b'x' * (MAX_ATTACHMENT_BYTES + 1), b'not-a-jpeg']:
            db = self.db()
            with patch('attachments.storage.save') as save, self.assertRaises(HTTPException):
                upload(db, {'user_id': 'u'}, self.file(content), 'image')
            save.assert_not_called()
            db.commit.assert_not_called()

    def test_storage_read_failure_returns_safe_retryable_error(self):
        db = Mock()
        db.execute.return_value.fetchone.return_value = {'attachment_url': '42.jpg'}
        with patch('attachments.storage.BUCKET', 'bucket'), \
                patch('attachments.storage.response', side_effect=EndpointConnectionError(endpoint_url='private-storage')), \
                self.assertLogs('attachments', level='WARNING'):
            with self.assertRaises(HTTPException) as caught:
                download_attachment(42, db, {'user_role_id': 1})
        self.assertEqual(caught.exception.status_code, 503)
        self.assertNotIn('private-storage', caught.exception.detail)

    def test_batch_export_stops_after_aggregate_limit(self):
        db = Mock()
        db.execute.return_value.fetchall.return_value = [
            {'attachment_id': value, 'attachment_type_id': 1, 'content_type': 'image/jpeg'} for value in range(1, 5)
        ]
        with patch('attachments.MAX_EXPORT_BYTES', 5), \
                patch('attachments.storage.response', return_value=Response(b'123')) as read:
            with self.assertRaises(HTTPException) as caught:
                export_attachments(AttachmentExport(ids=[1, 2, 3, 4]), db, {'user_role_id': 1})
        self.assertEqual(caught.exception.status_code, 413)
        self.assertIn('Select fewer', caught.exception.detail)
        self.assertEqual(read.call_count, 2)

    def test_batch_export_rejects_oversized_individual_object(self):
        db = Mock()
        db.execute.return_value.fetchall.return_value = [
            {'attachment_id': 1, 'attachment_type_id': 1, 'content_type': 'image/jpeg'}
        ]
        with patch('attachments.MAX_ATTACHMENT_BYTES', 2), \
                patch('attachments.storage.response', return_value=Response(b'123')):
            with self.assertRaises(HTTPException) as caught:
                export_attachments(AttachmentExport(ids=[1]), db, {'user_role_id': 1})
        self.assertEqual(caught.exception.status_code, 413)


if __name__ == '__main__':
    unittest.main()
