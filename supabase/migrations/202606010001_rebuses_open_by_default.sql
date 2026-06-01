alter table public.rebuses
  alter column status set default 'published'::public.rebus_status;

update public.rebuses
set status = 'published'::public.rebus_status
where status = 'draft'::public.rebus_status;
