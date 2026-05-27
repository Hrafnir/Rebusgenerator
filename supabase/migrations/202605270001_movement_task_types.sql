alter type public.task_type add value if not exists 'speed_photo';
alter type public.task_type add value if not exists 'pace_match';

create or replace function public.student_record_progress(raw_token text, target_task_id uuid, answer_text text default '', selected_option_ids uuid[] default '{}')
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  matched_session public.participant_sessions%rowtype;
  matched_student public.students%rowtype;
  matched_task public.tasks%rowtype;
  correct_ids uuid[];
  sorted_selected_ids uuid[];
  answer_is_correct boolean;
  awarded_points integer := 0;
  submitted_answer text := coalesce(answer_text, '');
  number_rules jsonb;
  numeric_answer double precision;
  correct_value double precision;
  deviation double precision;
  band jsonb;
  inserted_progress public.progress%rowtype;
  start_time timestamptz;
  first_lat double precision;
  first_lng double precision;
  duration_seconds double precision;
  distance_meters double precision;
  average_speed_kmh double precision;
  target_speed_kmh double precision;
begin
  select *
  into matched_session
  from public.participant_sessions ps
  where ps.token_hash = encode(extensions.digest(raw_token, 'sha256'), 'hex')
  order by ps.created_at desc
  limit 1;

  if matched_session.id is null then
    return null;
  end if;

  select * into matched_student from public.students s where s.id = matched_session.student_id;
  select * into matched_task from public.tasks t where t.id = target_task_id and t.rebus_id = matched_student.rebus_id;

  if matched_task.id is null then
    return null;
  end if;

  if matched_task.type in ('multiple_choice', 'multi_select') then
    select coalesce(array_agg(o.id order by o.id), '{}') into correct_ids
    from public.task_options o
    where o.task_id = matched_task.id and o.is_correct = true;

    select coalesce(array_agg(option_id order by option_id), '{}') into sorted_selected_ids
    from unnest(selected_option_ids) as option_id;

    answer_is_correct := correct_ids = sorted_selected_ids;
    awarded_points := case when answer_is_correct then matched_task.points else 0 end;
    submitted_answer := array_to_string(sorted_selected_ids, ',');
  elsif matched_task.type = 'find_destination' then
    answer_is_correct := true;
    awarded_points := matched_task.points;
    submitted_answer := '[FUNNET_FREM] Laget fant riktig sted.';
  elsif matched_task.type = 'pace_match' then
    select coalesce(max(p.created_at), matched_session.created_at)
    into start_time
    from public.progress p
    where p.student_id = matched_student.id;

    select l.latitude, l.longitude, extract(epoch from (now() - min(l.created_at)))
    into first_lat, first_lng, duration_seconds
    from public.locations l
    where l.student_id = matched_student.id
      and l.created_at >= start_time
    group by l.latitude, l.longitude, l.created_at
    order by l.created_at asc
    limit 1;

    if first_lat is null or matched_task.latitude is null or duration_seconds is null or duration_seconds <= 0 then
      average_speed_kmh := 0;
    else
      distance_meters := 6371000 * 2 * atan2(
        sqrt(
          power(sin(radians(matched_task.latitude - first_lat) / 2), 2) +
          cos(radians(first_lat)) * cos(radians(matched_task.latitude)) *
          power(sin(radians(matched_task.longitude - first_lng) / 2), 2)
        ),
        sqrt(1 - (
          power(sin(radians(matched_task.latitude - first_lat) / 2), 2) +
          cos(radians(first_lat)) * cos(radians(matched_task.latitude)) *
          power(sin(radians(matched_task.longitude - first_lng) / 2), 2)
        ))
      );
      average_speed_kmh := (distance_meters / duration_seconds) * 3.6;
    end if;

    target_speed_kmh := coalesce((matched_task.config #>> '{movement,targetSpeedKmh}')::double precision, 3);
    deviation := abs(average_speed_kmh - target_speed_kmh);
    awarded_points := greatest(0, round(matched_task.points * greatest(0, 1 - (deviation / greatest(target_speed_kmh, 0.1)))))::integer;
    answer_is_correct := true;
    submitted_answer := '[JEVN_FART] Snittfart ca. ' || round(average_speed_kmh::numeric, 2) || ' km/t. Mål: ' || target_speed_kmh || ' km/t.';
  elsif matched_task.type = 'number' and matched_task.config ? 'numberRules' then
    number_rules := matched_task.config -> 'numberRules';
    begin
      numeric_answer := submitted_answer::double precision;
      correct_value := (number_rules ->> 'correctValue')::double precision;
      deviation := abs(numeric_answer - correct_value);
      answer_is_correct := deviation = 0;
      awarded_points := 0;

      for band in
        select value
        from jsonb_array_elements(coalesce(number_rules -> 'bands', '[]'::jsonb)) value
        order by (value ->> 'maxDeviation')::double precision asc
      loop
        if deviation <= (band ->> 'maxDeviation')::double precision then
          awarded_points := (band ->> 'points')::integer;
          exit;
        end if;
      end loop;
    exception when others then
      answer_is_correct := false;
      awarded_points := 0;
    end;
  elsif matched_task.answer is not null and length(trim(matched_task.answer)) > 0 then
    answer_is_correct := lower(trim(submitted_answer)) = lower(trim(matched_task.answer));
    awarded_points := case when answer_is_correct then matched_task.points else 0 end;
  else
    answer_is_correct := null;
    awarded_points := 0;
  end if;

  insert into public.progress (student_id, rebus_id, task_id, answer, status, correct, points_awarded)
  values (
    matched_student.id,
    matched_student.rebus_id,
    matched_task.id,
    submitted_answer,
    case when answer_is_correct = false then 'needs_retry'::public.progress_status else 'submitted'::public.progress_status end,
    answer_is_correct,
    awarded_points
  )
  returning * into inserted_progress;

  update public.participant_sessions
  set last_seen_at = now()
  where id = matched_session.id;

  return jsonb_build_object(
    'id', inserted_progress.id,
    'studentId', inserted_progress.student_id,
    'rebusId', inserted_progress.rebus_id,
    'taskId', inserted_progress.task_id,
    'answer', inserted_progress.answer,
    'status', inserted_progress.status,
    'correct', inserted_progress.correct,
    'pointsAwarded', inserted_progress.points_awarded,
    'createdAt', inserted_progress.created_at
  );
end;
$$;

create or replace function public.student_record_submission(
  raw_token text,
  target_task_id uuid,
  storage_path_value text,
  original_name_value text,
  content_type_value text,
  size_bytes_value bigint,
  note_value text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  matched_session public.participant_sessions%rowtype;
  matched_student public.students%rowtype;
  matched_task public.tasks%rowtype;
  inserted_submission public.submissions%rowtype;
  inserted_progress public.progress%rowtype;
  submitted_answer text;
  start_time timestamptz;
  elapsed_seconds double precision;
begin
  select *
  into matched_session
  from public.participant_sessions ps
  where ps.token_hash = encode(extensions.digest(raw_token, 'sha256'), 'hex')
  order by ps.created_at desc
  limit 1;

  if matched_session.id is null then
    return null;
  end if;

  select * into matched_student
  from public.students s
  where s.id = matched_session.student_id;

  select * into matched_task
  from public.tasks t
  where t.id = target_task_id
    and t.rebus_id = matched_student.rebus_id
    and t.type in ('photo', 'video', 'audio', 'teacher_approved', 'speed_photo');

  if matched_task.id is null then
    return null;
  end if;

  insert into public.submissions (
    student_id,
    rebus_id,
    task_id,
    type,
    storage_bucket,
    storage_path,
    original_name,
    content_type,
    size_bytes,
    note,
    status
  )
  values (
    matched_student.id,
    matched_student.rebus_id,
    matched_task.id,
    matched_task.type,
    'submissions',
    storage_path_value,
    original_name_value,
    content_type_value,
    size_bytes_value,
    coalesce(note_value, ''),
    'submitted'::public.progress_status
  )
  returning * into inserted_submission;

  if matched_task.type = 'speed_photo' then
    select coalesce(max(p.created_at), matched_session.created_at)
    into start_time
    from public.progress p
    where p.student_id = matched_student.id;

    elapsed_seconds := extract(epoch from (now() - coalesce(start_time, matched_session.created_at)));
    submitted_answer := '[RASK_ETAPPE] Tid brukt ca. ' || greatest(1, round((elapsed_seconds / 60)::numeric, 1)) || ' min. Bilde levert: ' || coalesce(original_name_value, 'Innlevering');
  else
    submitted_answer := '[MEDIA_LEVERT] ' || coalesce(original_name_value, 'Innlevering');
  end if;

  if length(trim(coalesce(note_value, ''))) > 0 then
    submitted_answer := submitted_answer || ' - ' || trim(note_value);
  end if;

  insert into public.progress (student_id, rebus_id, task_id, answer, status, correct, points_awarded)
  values (
    matched_student.id,
    matched_student.rebus_id,
    matched_task.id,
    submitted_answer,
    'submitted'::public.progress_status,
    case when matched_task.type = 'speed_photo' then true else null end,
    case when matched_task.type = 'speed_photo' then matched_task.points else 0 end
  )
  returning * into inserted_progress;

  update public.participant_sessions
  set last_seen_at = now()
  where id = matched_session.id;

  return jsonb_build_object(
    'submission', jsonb_build_object(
      'id', inserted_submission.id,
      'studentId', inserted_submission.student_id,
      'rebusId', inserted_submission.rebus_id,
      'taskId', inserted_submission.task_id,
      'type', inserted_submission.type,
      'storageBucket', inserted_submission.storage_bucket,
      'storagePath', inserted_submission.storage_path,
      'originalName', inserted_submission.original_name,
      'contentType', inserted_submission.content_type,
      'sizeBytes', inserted_submission.size_bytes,
      'note', inserted_submission.note,
      'status', inserted_submission.status,
      'createdAt', inserted_submission.created_at
    ),
    'progress', jsonb_build_object(
      'id', inserted_progress.id,
      'studentId', inserted_progress.student_id,
      'rebusId', inserted_progress.rebus_id,
      'taskId', inserted_progress.task_id,
      'answer', inserted_progress.answer,
      'status', inserted_progress.status,
      'correct', inserted_progress.correct,
      'pointsAwarded', inserted_progress.points_awarded,
      'createdAt', inserted_progress.created_at
    )
  );
end;
$$;

grant execute on function public.student_record_submission(text, uuid, text, text, text, bigint, text) to anon, authenticated;
