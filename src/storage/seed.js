const { REBUS_STATUS, TASK_TYPES, nowIso } = require('../shared/domain');

function createSeedData() {
  const createdAt = nowIso();
  return {
    teachers: [
      {
        id: 'teacher_demo',
        name: 'Demo lærer',
        email: 'teacher@example.com',
        provider: 'google-dev',
        createdAt
      }
    ],
    rebuses: [
      {
        id: 'rebus_demo_fastland',
        ownerTeacherId: 'teacher_demo',
        title: 'Demo: Fastland-rebus',
        description: 'En enkel demo som viser hvordan en lærer kan bygge poster med kartlokasjoner.',
        status: REBUS_STATUS.PUBLISHED,
        startsAt: null,
        endsAt: null,
        createdAt,
        updatedAt: createdAt
      }
    ],
    tasks: [
      {
        id: 'task_demo_start',
        rebusId: 'rebus_demo_fastland',
        title: 'Start ved Fastland',
        description: 'Finn startpunktet og svar på spørsmålet.',
        type: TASK_TYPES.TEXT,
        prompt: 'Hva heter området dere starter på?',
        answer: 'FASTLAND',
        points: 5,
        order: 1,
        geofenceRadiusMeters: 30,
        location: {
          lat: 60.79823355219047,
          lng: 10.674827839521527,
          label: 'Fastland'
        },
        createdAt,
        updatedAt: createdAt
      }
    ],
    students: [
      {
        id: 'student_demo_1',
        rebusId: 'rebus_demo_fastland',
        displayName: 'Demo elev',
        username: 'demo',
        password: 'demo',
        teamName: 'Demo-laget',
        createdAt
      }
    ],
    sessions: [],
    progress: [],
    locations: [],
    submissions: [],
    events: []
  };
}

module.exports = { createSeedData };
