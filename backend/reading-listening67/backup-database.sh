#!/usr/bin/env bash
# Đọc database RL riêng, tạo bản sao nhất quán; không đọc/ghi bảng Writing.
# Đầu ra là archive riêng tư và checksum; lỗi trả exit khác 0, giữ log để điều tra.
set -euo pipefail
umask 077
backup_root=/opt/izone-reading-listening67-backups
mkdir -p "$backup_root"
test "$(readlink -f "$backup_root")" = /opt/izone-reading-listening67-backups
exec 9>/var/lock/reading-listening67-backup.lock
flock -n 9 || exit 0
stamp=$(date -u +%Y%m%dT%H%M%SZ)
archive="$backup_root/reading-listening67-$stamp.dump"
temporary="$archive.pending"
trap 'rm -f -- "$temporary"' EXIT
docker exec mapping-postgres pg_dump -U mapping_admin -d reading_listening67 --format=custom > "$temporary"
test -s "$temporary"
docker exec -i mapping-postgres pg_restore --list < "$temporary" > /dev/null
mv -- "$temporary" "$archive"
sha256sum "$archive" > "$archive.sha256"
# Chỉ dọn bản sao của luồng này trong thư mục đã xác minh; giữ 30 ngày.
find "$backup_root" -maxdepth 1 -type f -name 'reading-listening67-*.dump*' -mtime +30 -delete
printf 'Đã sao lưu Reading/Listening 67: %s\n' "$stamp"
