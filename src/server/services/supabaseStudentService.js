const crypto = require('crypto');
const { config } = require('../config');

function isSupabaseStudentMode() {
  return Boolean(config.supabaseUrl && config.supabaseServiceRoleKey);
}

async function supabaseRequest(path, options = {}) {
  const response = await fetch(`${config.supabaseUrl}/rest/v1${path}`, {
    ...options,
    headers: {
      apikey: config.supabaseServiceRoleKey,
      authorization: `Bearer ${config.supabaseServiceRoleKey}`,
      'content-type': 'application/json',
      prefer: 'return=representation',
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message = data?.message || data?.error || `Supabase HTTP ${response.status}`;
    throw new Error(message);
  }
  return data;
}

async function loginStudentSupabase(username, password, rebusId = null) {
  const normalizedUsername = String(username || '').trim().toLowerCase();
  const query = [
    `username=eq.${encodeURIComponent(normalizedUsername)}`,
    rebusId ? `rebus_id=eq.${encodeURIComponent(rebusId)}` : '',
    'select=id,rebus_id,display_name,username,password_hash,team_name,rebuses(id,title,description,status)'
  ].filter(Boolean).join('&');
  const students = await supabaseRequest(`/students?${query}`);
  const student = students.find(item => item.password_hash === `plain:${password}`);
  if (!student) return null;

  const token = crypto.randomBytes(24).toString('hex');
  const tokenHash = hashToken(token);
  await supabaseRequest('/participant_sessions', {
    method: 'POST',
    body: JSON.stringify({
      student_id: student.id,
      token_hash: tokenHash
    })
  });

  return buildStudentSession(student.id, token);
}

async function getStudentSessionSupabase(token) {
  const session = await findSession(token);
  if (!session) return null;
  return buildStudentSession(session.student_id, token);
}

async function recordLocationSupabase(token, input) {
  const session = await findSession(token);
  if (!session) return null;
  const student = await getStudent(session.student_id);
  const payload = {
    student_id: student.id,
    rebus_id: student.rebus_id,
    latitude: Number(input.lat),
    longitude: Number(input.lng),
    accuracy: input.accuracy ? Number(input.accuracy) : null
  };
  const rows = await supabaseRequest('/locations', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
  await supabaseRequest(`/participant_sessions?id=eq.${session.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ last_seen_at: new Date().toISOString() })
  });
  return rows[0] || null;
}

async function recordProgressSupabase(token, input) {
  const session = await findSession(token);
  if (!session) return null;
  const student = await getStudent(session.student_id);
  const task = await getTask(input.taskId);
  if (!task || task.rebus_id !== student.rebus_id) return null;

  const evaluation = evaluateAnswer(task, input.answer, input.optionIds || []);
  const rows = await supabaseRequest('/progress', {
    method: 'POST',
    body: JSON.stringify({
      student_id: student.id,
      rebus_id: student.rebus_id,
      task_id: task.id,
      answer: evaluation.answerText,
      status: evaluation.correct === false ? 'needs_retry' : 'submitted',
      correct: evaluation.correct,
      points_awarded: evaluation.pointsAwarded
    })
  });
  return normalizeProgress(rows[0]);
}

async function recordSubmissionSupabase(token, input) {
  const session = await findSession(token);
  if (!session) return null;
  const student = await getStudent(session.student_id);
  const task = await getTask(input.taskId);
  if (!task || task.rebus_id !== student.rebus_id) return null;

  const submissionRows = await supabaseRequest('/submissions', {
    method: 'POST',
    body: JSON.stringify({
      student_id: student.id,
      rebus_id: student.rebus_id,
      task_id: task.id,
      type: task.type,
      storage_bucket: 'local-dev',
      storage_path: `/uploads/${input.storedName}`,
      original_name: input.originalName,
      content_type: input.contentType,
      size_bytes: input.size,
      note: input.note || '',
      status: 'submitted'
    })
  });

  const progressRows = await supabaseRequest('/progress', {
    method: 'POST',
    body: JSON.stringify({
      student_id: student.id,
      rebus_id: student.rebus_id,
      task_id: task.id,
      answer: task.type === 'speed_photo' ? `[RASK_ETAPPE] Bilde levert: ${input.originalName || 'innlevering'}` : (input.note || input.originalName || ''),
      status: 'submitted',
      correct: task.type === 'speed_photo' ? true : null,
      points_awarded: task.type === 'speed_photo' ? Number(task.points || 0) : 0
    })
  });

  return {
    submission: normalizeSubmission(submissionRows[0]),
    progress: normalizeProgress(progressRows[0])
  };
}

async function buildStudentSession(studentId, token) {
  const student = await getStudent(studentId);
  const tasks = await supabaseRequest(`/tasks?rebus_id=eq.${student.rebus_id}&select=*,task_options(*),task_assets(*),task_hints(*),rebus_stops(*)&order=sort_order.asc`);
  const progress = await supabaseRequest(`/progress?student_id=eq.${student.id}&select=*&order=created_at.asc`);
  return {
    token,
    student: {
      id: student.id,
      displayName: student.display_name,
      username: student.username,
      rebusId: student.rebus_id,
      teamName: student.team_name
    },
    rebus: {
      id: student.rebuses.id,
      title: student.rebuses.title,
      description: student.rebuses.description,
      status: student.rebuses.status
    },
    tasks: tasks.map(normalizeTask),
    progress: progress.map(normalizeProgress),
    submissions: []
  };
}

async function findSession(token) {
  const tokenHash = hashToken(token);
  const sessions = await supabaseRequest(`/participant_sessions?token_hash=eq.${encodeURIComponent(tokenHash)}&select=*`);
  return sessions[0] || null;
}

async function getStudent(studentId) {
  const rows = await supabaseRequest(`/students?id=eq.${encodeURIComponent(studentId)}&select=id,rebus_id,display_name,username,team_name,rebuses(id,title,description,status)`);
  return rows[0] || null;
}

async function getTask(taskId) {
  const rows = await supabaseRequest(`/tasks?id=eq.${encodeURIComponent(taskId)}&select=*,task_options(*)`);
  return rows[0] || null;
}

function evaluateAnswer(task, answer, optionIds) {
  if (task.type === 'multiple_choice' || task.type === 'multi_select') {
    const correctIds = (task.task_options || []).filter(option => option.is_correct).map(option => option.id).sort();
    const selectedIds = [...optionIds].sort();
    const correct = task.type === 'multiple_choice'
      ? selectedIds.length === 1 && correctIds.includes(selectedIds[0])
      : JSON.stringify(correctIds) === JSON.stringify(selectedIds);
    return {
      answerText: selectedIds.join(','),
      correct,
      pointsAwarded: correct ? task.points : 0
    };
  }

  if (task.type === 'number' && task.config?.numberRules) {
    const value = Number(answer);
    const rules = task.config.numberRules;
    if (!Number.isFinite(value)) return { answerText: String(answer || ''), correct: false, pointsAwarded: 0 };
    const deviation = Math.abs(value - Number(rules.correctValue));
    const matchingBand = [...(rules.bands || [])]
      .sort((a, b) => Number(a.maxDeviation) - Number(b.maxDeviation))
      .find(band => deviation <= Number(band.maxDeviation));
    return {
      answerText: String(value),
      correct: deviation === 0,
      pointsAwarded: matchingBand ? Number(matchingBand.points) : 0
    };
  }

  if (task.type === 'find_destination') {
    return {
      answerText: '[FUNNET_FREM] Laget fant riktig sted.',
      correct: true,
      pointsAwarded: task.points
    };
  }

  if (task.type === 'pace_match') {
    return {
      answerText: '[JEVN_FART] Fremme. Fart beregnes i Supabase-modus.',
      correct: true,
      pointsAwarded: task.points
    };
  }

  if (task.answer) {
    const correct = String(answer || '').trim().toLowerCase() === String(task.answer).trim().toLowerCase();
    return {
      answerText: String(answer || ''),
      correct,
      pointsAwarded: correct ? task.points : 0
    };
  }

  return {
    answerText: String(answer || ''),
    correct: null,
    pointsAwarded: 0
  };
}

function normalizeTask(task) {
  return {
    id: task.id,
    rebusId: task.rebus_id,
    stopId: task.stop_id,
    title: task.title,
    description: task.description,
    type: task.type,
    prompt: task.prompt,
    points: task.points,
    order: task.sort_order,
    maxAttempts: task.max_attempts,
    geofenceRadiusMeters: task.geofence_radius_meters,
    config: task.config || {},
    location: Number.isFinite(task.latitude) && Number.isFinite(task.longitude)
      ? { lat: task.latitude, lng: task.longitude, label: task.location_label || '' }
      : null,
    stop: task.rebus_stops ? {
      id: task.rebus_stops.id,
      title: task.rebus_stops.title,
      location: Number.isFinite(task.rebus_stops.latitude) && Number.isFinite(task.rebus_stops.longitude)
        ? { lat: task.rebus_stops.latitude, lng: task.rebus_stops.longitude, label: task.rebus_stops.location_label || '' }
        : null
    } : null,
    options: (task.task_options || []).sort((a, b) => a.sort_order - b.sort_order).map(option => ({
      id: option.id,
      label: option.label
    })),
    assets: (task.task_assets || []).sort((a, b) => a.sort_order - b.sort_order).map(asset => ({
      id: asset.id,
      type: asset.type,
      title: asset.title,
      url: asset.url
    })),
    hints: (task.task_hints || []).sort((a, b) => a.sort_order - b.sort_order).map(hint => ({
      id: hint.id,
      body: hint.body
    }))
  };
}

function normalizeProgress(progress) {
  return {
    id: progress.id,
    studentId: progress.student_id,
    rebusId: progress.rebus_id,
    taskId: progress.task_id,
    answer: progress.answer,
    status: progress.status,
    correct: progress.correct,
    pointsAwarded: progress.points_awarded,
    createdAt: progress.created_at
  };
}

function normalizeSubmission(submission) {
  return {
    id: submission.id,
    studentId: submission.student_id,
    rebusId: submission.rebus_id,
    taskId: submission.task_id,
    type: submission.type,
    storageBucket: submission.storage_bucket,
    storagePath: submission.storage_path,
    originalName: submission.original_name,
    contentType: submission.content_type,
    size: submission.size_bytes,
    note: submission.note,
    status: submission.status,
    createdAt: submission.created_at
  };
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

module.exports = {
  isSupabaseStudentMode,
  loginStudentSupabase,
  getStudentSessionSupabase,
  recordLocationSupabase,
  recordProgressSupabase,
  recordSubmissionSupabase
};
