create or replace function public.my_invitation_status()
returns table (
  kind text,
  target_id uuid,
  target_name text,
  role text,
  email text,
  created_at timestamptz,
  accepted_at timestamptz
)
language sql
security definer
stable
set search_path = public
as $$
  with profile_row as (
    select lower(email) as email
    from public.profiles
    where id = auth.uid()
  )
  select
    'organization'::text as kind,
    invitation.organization_id as target_id,
    organization.name as target_name,
    invitation.role::text as role,
    invitation.email,
    invitation.created_at,
    invitation.accepted_at
  from public.organization_invitations invitation
  join public.organizations organization on organization.id = invitation.organization_id
  join profile_row profile on lower(invitation.email) = profile.email
  union all
  select
    'rebus'::text as kind,
    invitation.rebus_id as target_id,
    rebus.title as target_name,
    invitation.role::text as role,
    invitation.email,
    invitation.created_at,
    invitation.accepted_at
  from public.rebus_invitations invitation
  join public.rebuses rebus on rebus.id = invitation.rebus_id
  join profile_row profile on lower(invitation.email) = profile.email
  order by created_at desc;
$$;

grant execute on function public.my_invitation_status() to authenticated;
