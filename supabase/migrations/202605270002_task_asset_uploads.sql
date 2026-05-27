insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'task-assets',
  'task-assets',
  true,
  104857600,
  array[
    'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif',
    'video/mp4', 'video/quicktime', 'video/webm',
    'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/webm', 'audio/x-m4a', 'audio/aac', 'audio/ogg',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  ]
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "task_assets_bucket_admin_upload" on storage.objects;
create policy "task_assets_bucket_admin_upload"
on storage.objects for insert
to authenticated
with check (bucket_id = 'task-assets');

drop policy if exists "task_assets_bucket_admin_update" on storage.objects;
create policy "task_assets_bucket_admin_update"
on storage.objects for update
to authenticated
using (bucket_id = 'task-assets')
with check (bucket_id = 'task-assets');

drop policy if exists "task_assets_bucket_admin_delete" on storage.objects;
create policy "task_assets_bucket_admin_delete"
on storage.objects for delete
to authenticated
using (bucket_id = 'task-assets');
