# Client production instance

Installed on 6 October 2026 from commit ac7922c46f722218fde4e1d511f6072329115ed8.

- SSH and application: ubuntu@52.220.117.224 and https://52.220.117.224.
- Ubuntu 24.04; Docker Compose runs PostgreSQL 17, FastAPI and Caddy.
- Infrastructure: /opt/cashbook/deploy; releases: /opt/cashbook/releases/<SHA>; active commit: /opt/cashbook/current-release.
- Compose project: cashbook-v2; database volume: cashbook_database_v2.
- AWS account: 472158500612; runtime identity: cashbook_s3_bucket_access.
- S3 bucket: cash-book-management-backup, region ap-south-1 (Mumbai). This differs from the server's Singapore region.
- Media prefix: attatchments/; backup prefix: pg_dump/.
- Original database snapshot: pg_dump/cashbook-v2-20261005T220005Z.dump. Restored 12 users, 283 transactions, 259 attachments, schema version 8. Existing passwords were preserved and sessions cleared.
- All 259 database attachment paths were verified in the client bucket. Signed image/audio downloads, batch image export and temporary attachment write/read/delete were checked.
- Root-only recovery copies: /opt/cashbook/recovery/migration-original.dump and client-backup-verified.dump. The new bucket backup was restored into a temporary verification database and checked before that database was removed.
- Daily cashbook-backup.timer: 03:00 Asia/Karachi. Backups go to the client bucket; external failure notifications are not configured.

The private runtime credential file is deploy/secrets/aws_credentials, owned by UID/GID 10001, mode 400. Its default profile explicitly sets S3 signature_version=s3v4 and addressing_style=virtual so signed downloads use the regional endpoint. Configuration is in root-only deploy/.env. Neither belongs in Git.

GitHub's production environment uses DEPLOY_HOST=52.220.117.224 and a new dedicated SSH key restricted to /usr/local/bin/cashbook-ci. DEPLOY_KNOWN_HOSTS pins this server. The old server's deployment key was revoked; its administrative key still works.

Verified end-to-end GitHub Actions deployment: https://github.com/Eli-xir/transaction-management-system/actions/runs/37409497605. The workflow built and deployed the checked commit, uploaded a pre-migration backup, initialized the schema and passed HTTPS checks. The installed systemd backup service also completed successfully. Keep environment files and SSH secrets in LF format; Windows CRLF caused initial deployment checks to fail.

Apache's previous OpenClaw routing was disabled to free ports 80/443. Its configuration was preserved in /opt/cashbook/recovery/apache-before-cashbook.tar.gz; OpenClaw itself was not removed.

Vercel remains intentionally pointed at 13.202.242.159 in frontend/vercel.json. The two databases are independent; this snapshot does not include entries made later on the old installation. After confirming the migration, the user requested that the old installation be taken offline. Its app and backup timer were stopped, followed by an operating-system shutdown; the AWS instance has not been deleted because the available IAM credentials cannot manage Lightsail. Its final recovery dump is preserved at pg_dump/cashbook-old-before-retirement-20261006T034738Z.dump in the client bucket. No final synchronization was applied to the client database. The old Vercel API route is now unavailable; switching it remains a separate step.
