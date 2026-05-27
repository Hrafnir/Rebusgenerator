const TASK_TYPES = {
  TEXT: 'text',
  FIND_DESTINATION: 'find_destination',
  SPEED_PHOTO: 'speed_photo',
  PACE_MATCH: 'pace_match',
  NUMBER: 'number',
  MULTIPLE_CHOICE: 'multiple_choice',
  MULTI_SELECT: 'multi_select',
  PHOTO: 'photo',
  VIDEO: 'video',
  AUDIO: 'audio',
  TEACHER_APPROVED: 'teacher_approved'
};

const REBUS_STATUS = {
  DRAFT: 'draft',
  PUBLISHED: 'published',
  ARCHIVED: 'archived'
};

function nowIso() {
  return new Date().toISOString();
}

function createId(prefix) {
  return `${prefix}_${cryptoRandom()}`;
}

function cryptoRandom() {
  return require('crypto').randomBytes(8).toString('hex');
}

function publicStudent(student) {
  if (!student) return null;
  return {
    id: student.id,
    displayName: student.displayName,
    username: student.username,
    rebusId: student.rebusId,
    teamName: student.teamName || null,
    createdAt: student.createdAt
  };
}

module.exports = {
  TASK_TYPES,
  REBUS_STATUS,
  nowIso,
  createId,
  publicStudent
};
