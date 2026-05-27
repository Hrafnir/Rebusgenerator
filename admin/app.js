(function () {
  const SELECTED_ORG_STORAGE_KEY = 'selectedOrganizationId';

  const state = {
    config: null,
    mode: 'local',
    supabase: null,
    session: null,
    user: null,
    profile: null,
    teacherEmail: localStorage.getItem('teacherEmail') || 'teacher@example.com',
    teacher: null,
    organizations: [],
    selectedOrganization: null,
    projectSettings: null,
    rebuses: [],
    selectedRebus: null,
    selectedStopId: '',
    editingTaskId: null,
    map: null,
    marker: null,
    liveMap: null,
    liveMarkers: new Map(),
    autocomplete: null,
    loadedMapsKey: '',
    optionRows: [],
    assetRows: [],
    hintRows: [],
    numberBands: [],
    lastSuggestedGroupName: '',
    lastSuggestedGroupUsername: '',
    activeAdminTab: 'settings',
    activeChatStudentId: null,
    organizationPickerOpen: false,
    groupMessages: [],
    seenMessageIds: new Set(),
    adminMessageDrafts: new Map(),
    expandedGroupId: null,
    access: {
      orgMembers: [],
      orgInvites: [],
      rebusAdmins: [],
      rebusInvites: []
    },
    orgSidebarCollapsed: localStorage.getItem('orgSidebarCollapsed') === 'true'
  };

  const $ = id => document.getElementById(id);
  const localHeaders = () => ({
    'content-type': 'application/json',
    'x-teacher-email': state.teacherEmail,
    ...(state.teacher ? { 'x-teacher-id': state.teacher.id } : {})
  });

  async function boot() {
    state.config = await loadConfig();
    state.mode = state.config.supabaseUrl && state.config.supabaseAnonKey ? 'supabase' : 'local';
    $('teacher-email').value = state.teacherEmail;
    initAdminLayoutControls();
    configureAuthUi();

    if (state.mode === 'supabase') {
      await bootSupabase();
    } else {
      setWorkspaceVisible(true);
      configureMapsUi();
      await devLogin();
    }
    resetTaskBuilder();
    updateTaskTypeUi();
    seedGroupPassword();
  }

  async function bootSupabase() {
    await loadScript('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2');
    state.supabase = window.supabase.createClient(state.config.supabaseUrl, state.config.supabaseAnonKey);
    $('auth-status').textContent = 'Sjekker innlogging...';
    const { data } = await state.supabase.auth.getSession();
    if (data.session) {
      await setSupabaseSession(data.session);
      cleanAuthUrl();
    } else {
      updateAuthStatus();
    }
    state.supabase.auth.onAuthStateChange((_event, session) => {
      if (session) setSupabaseSession(session).catch(error => alert(error.message));
      else clearSupabaseSession();
    });
  }

  function configureAuthUi() {
    const usingSupabase = state.mode === 'supabase';
    $('supabase-login-button').hidden = !usingSupabase;
    $('logout-button').hidden = true;
    if ($('email-auth-panel')) $('email-auth-panel').hidden = !usingSupabase;
    $('google-login-slot').hidden = usingSupabase;
    $('login-button').hidden = usingSupabase || !state.config.allowDevAuth;
    $('teacher-email').hidden = usingSupabase || !state.config.allowDevAuth;
    updateAuthStatus();

    if (!usingSupabase && state.config.googleClientId) {
      $('login-button').hidden = true;
      $('teacher-email').hidden = true;
      loadScript('https://accounts.google.com/gsi/client')
        .then(() => {
          google.accounts.id.initialize({
            client_id: state.config.googleClientId,
            callback: handleGoogleCredential
          });
          google.accounts.id.renderButton($('google-login-slot'), {
            theme: 'outline',
            size: 'large',
            text: 'signin_with',
            locale: 'no'
          });
        })
        .catch(() => {
          $('login-button').hidden = false;
          $('teacher-email').hidden = false;
        });
    }
  }

  function initAdminLayoutControls() {
    const grid = $('admin-grid');
    const storedOrgWidth = Number(localStorage.getItem('orgPaneWidth') || 300);
    const storedChatWidth = Number(localStorage.getItem('chatPaneWidth') || 340);
    setPaneWidth('left', storedOrgWidth);
    setPaneWidth('chat', storedChatWidth);
    applyOrgSidebarState();

    $('toggle-org-sidebar-button')?.addEventListener('click', () => {
      state.orgSidebarCollapsed = !state.orgSidebarCollapsed;
      localStorage.setItem('orgSidebarCollapsed', String(state.orgSidebarCollapsed));
      localStorage.setItem('orgSidebarManual', 'true');
      applyOrgSidebarState();
    });

    document.querySelectorAll('[data-resize-pane]').forEach(handle => {
      handle.addEventListener('pointerdown', event => {
        if (!grid || window.matchMedia('(max-width: 820px)').matches) return;
        const pane = handle.dataset.resizePane;
        const startX = event.clientX;
        const startWidth = pane === 'left'
          ? Number(localStorage.getItem('orgPaneWidth') || 300)
          : Number(localStorage.getItem('chatPaneWidth') || 340);
        handle.setPointerCapture(event.pointerId);
        handle.classList.add('is-dragging');

        const onMove = moveEvent => {
          const delta = moveEvent.clientX - startX;
          const nextWidth = pane === 'left' ? startWidth + delta : startWidth - delta;
          setPaneWidth(pane, nextWidth, true);
        };
        const onUp = () => {
          handle.classList.remove('is-dragging');
          handle.removeEventListener('pointermove', onMove);
          handle.removeEventListener('pointerup', onUp);
          handle.removeEventListener('pointercancel', onUp);
        };
        handle.addEventListener('pointermove', onMove);
        handle.addEventListener('pointerup', onUp);
        handle.addEventListener('pointercancel', onUp);
      });
    });
  }

  function setPaneWidth(pane, width, persist = false) {
    const clamped = Math.round(Math.min(Math.max(Number(width) || 0, pane === 'left' ? 220 : 280), pane === 'left' ? 520 : 560));
    if (pane === 'left') {
      document.documentElement.style.setProperty('--org-width', state.orgSidebarCollapsed ? '56px' : `${clamped}px`);
      if (persist) localStorage.setItem('orgPaneWidth', String(clamped));
    } else {
      document.documentElement.style.setProperty('--chat-width', `${clamped}px`);
      if (persist) localStorage.setItem('chatPaneWidth', String(clamped));
    }
  }

  function applyOrgSidebarState() {
    const sidebar = $('org-sidebar');
    const handle = document.querySelector('.left-resize-handle');
    const button = $('toggle-org-sidebar-button');
    if (!sidebar) return;
    sidebar.classList.toggle('is-collapsed', state.orgSidebarCollapsed);
    if (button) button.textContent = state.orgSidebarCollapsed ? 'Vis' : 'Skjul';
    const width = Number(localStorage.getItem('orgPaneWidth') || 300);
    document.documentElement.style.setProperty('--org-width', state.orgSidebarCollapsed ? '56px' : `${width}px`);
  }

  async function signInWithSupabaseGoogle() {
    const { error } = await state.supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: appUrl('admin/') }
    });
    if (error) throw error;
  }

  async function signInWithEmailPassword() {
    if (state.mode !== 'supabase') return;
    const email = $('email-auth-email').value.trim().toLowerCase();
    const password = $('email-auth-password').value;
    if (!email || !password) return setEmailAuthStatus('Skriv inn e-post og passord først.');
    setEmailAuthStatus('Logger inn...');
    const { error } = await state.supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    setEmailAuthStatus('');
  }

  async function signUpWithEmailPassword() {
    if (state.mode !== 'supabase') return;
    const email = $('email-auth-email').value.trim().toLowerCase();
    const password = $('email-auth-password').value;
    const fullName = $('email-auth-name').value.trim();
    if (!email || !password) return setEmailAuthStatus('Skriv inn e-post og passord først.');
    if (password.length < 6) return setEmailAuthStatus('Passordet må ha minst 6 tegn.');
    setEmailAuthStatus('Oppretter konto...');
    const { data, error } = await state.supabase.auth.signUp({
      email,
      password,
      options: {
        data: { full_name: fullName || email },
        emailRedirectTo: appUrl('admin/')
      }
    });
    if (error) throw error;
    if (!data.session) {
      setEmailAuthStatus('Konto opprettet. Sjekk e-posten din og bekreft kontoen før du logger inn.');
      return;
    }
    setEmailAuthStatus('');
  }

  function setEmailAuthStatus(message) {
    const element = $('email-auth-status');
    if (element) element.textContent = message || '';
  }

  async function setSupabaseSession(session) {
    state.session = session;
    state.user = session.user;
    state.teacherEmail = state.user.email;
    localStorage.setItem('teacherEmail', state.teacherEmail);
    $('logout-button').hidden = false;
    $('supabase-login-button').hidden = true;
    if ($('email-auth-panel')) $('email-auth-panel').hidden = true;
    updateAuthStatus();
    await acceptInvitations();
    await loadProfile();
    await loadOrganizations();
    await loadLive();
  }

  function clearSupabaseSession() {
    state.session = null;
    state.user = null;
    state.profile = null;
    state.organizations = [];
    state.selectedOrganization = null;
    state.projectSettings = null;
    state.rebuses = [];
    state.selectedRebus = null;
    state.access = { orgMembers: [], orgInvites: [], rebusAdmins: [], rebusInvites: [] };
    localStorage.removeItem(SELECTED_ORG_STORAGE_KEY);
    $('logout-button').hidden = true;
    $('supabase-login-button').hidden = false;
    if ($('email-auth-panel')) $('email-auth-panel').hidden = false;
    updateAuthStatus();
    renderProfile();
    state.organizationPickerOpen = false;
    setWorkspaceVisible(false);
    renderOrganizations();
    renderRebusList();
    renderEmptyRebus();
  }

  async function logout() {
    if (state.supabase) await state.supabase.auth.signOut();
    clearSupabaseSession();
  }

  async function localApi(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: { ...localHeaders(), ...(options.headers || {}) }
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'API-feil');
    return data;
  }

  async function handleGoogleCredential(response) {
    const data = await fetch('/api/auth/google', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ credential: response.credential })
    }).then(async result => {
      const payload = await result.json();
      if (!result.ok) throw new Error(payload.error || 'Google-login feilet.');
      return payload;
    });
    setLocalTeacher(data.teacher);
    await loadRebuses();
    await loadLive();
  }

  async function devLogin() {
    if (!state.config.allowDevAuth || state.config.googleClientId) return;
    state.teacherEmail = $('teacher-email').value.trim() || 'teacher@example.com';
    const response = await fetch('/api/auth/google/dev', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: state.teacherEmail })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Dev-login feilet.');
    setLocalTeacher(data.teacher);
    await loadRebuses();
    await loadLive();
  }

  function setLocalTeacher(teacher) {
    state.teacher = teacher;
    state.teacherEmail = teacher.email;
    localStorage.setItem('teacherEmail', teacher.email);
    $('teacher-email').value = teacher.email;
    updateAuthStatus();
  }

  function updateAuthStatus() {
    const status = $('auth-status');
    if (!status) return;
    const signedInEmail = state.user?.email || state.teacher?.email || '';
    if (signedInEmail) {
      const name = state.user?.user_metadata?.full_name || state.user?.user_metadata?.name || state.teacher?.name || signedInEmail;
      status.textContent = `Innlogget: ${name}`;
      status.title = signedInEmail;
      status.classList.add('signed-in');
    } else {
      status.textContent = state.mode === 'supabase' ? 'Ikke innlogget' : 'Dev-modus';
      status.title = '';
      status.classList.remove('signed-in');
    }
  }

  function setWorkspaceVisible(visible) {
    const onboarding = $('organization-onboarding');
    const workspace = $('admin-workspace');
    if (onboarding) onboarding.hidden = state.mode !== 'supabase' || visible || !state.user;
    if (workspace) workspace.hidden = state.mode === 'supabase' ? !visible : false;
  }

  async function acceptInvitations() {
    if (state.mode !== 'supabase' || !state.supabase) return;
    const { data, error } = await state.supabase.rpc('accept_my_invitations');
    if (error) throw error;
    const accepted = Number(data?.organizationInvites || 0) + Number(data?.rebusInvites || 0);
    if (accepted) showNotification('Invitasjon aktivert', `Du fikk tilgang til ${accepted} nytt område.`);
  }

  async function loadProfile() {
    if (state.mode !== 'supabase' || !state.user) return;
    const { data, error } = await state.supabase
      .from('profiles')
      .select('id, email, full_name, nickname')
      .eq('id', state.user.id)
      .maybeSingle();
    if (error) throw error;
    state.profile = data;
    renderProfile();
  }

  function renderProfile() {
    const card = $('profile-card');
    if (!card) return;
    card.hidden = state.mode !== 'supabase' || !state.user;
    if ($('teacher-nickname')) {
      $('teacher-nickname').value = state.profile?.nickname || suggestedTeacherNick();
    }
  }

  async function saveNickname() {
    if (state.mode !== 'supabase' || !state.user) return;
    const nickname = $('teacher-nickname').value.trim() || suggestedTeacherNick();
    const { data, error } = await state.supabase
      .from('profiles')
      .update({ nickname })
      .eq('id', state.user.id)
      .select('id, email, full_name, nickname')
      .single();
    if (error) throw error;
    state.profile = data;
    renderProfile();
    showNotification('Nick lagret', `Elevene ser deg som Lærer - ${nickname}.`);
  }

  function suggestedTeacherNick() {
    const name = state.profile?.full_name || state.user?.user_metadata?.full_name || state.user?.user_metadata?.name || state.user?.email || 'Lærer';
    return String(name).split(/\s+/)[0] || 'Lærer';
  }

  function cleanAuthUrl() {
    if (window.location.hash || window.location.search.includes('code=')) {
      history.replaceState(null, document.title, window.location.pathname);
    }
  }

  async function loadOrganizations() {
    if (state.mode !== 'supabase') return;
    const { data, error } = await state.supabase
      .from('organizations')
      .select('id, name, created_at, project_settings(*)')
      .order('created_at', { ascending: true });
    if (error) throw error;
    state.organizations = data || [];
    const rememberedId = localStorage.getItem(SELECTED_ORG_STORAGE_KEY);
    const rememberedOrganization = state.organizations.find(org => org.id === rememberedId);
    if (rememberedOrganization) {
      await selectOrganization(rememberedOrganization.id);
    } else {
      state.selectedOrganization = null;
      state.projectSettings = null;
      state.rebuses = [];
      state.selectedRebus = null;
      state.organizationPickerOpen = false;
      setWorkspaceVisible(false);
      renderOrganizations();
      renderRebusList();
      renderEmptyRebus();
    }
  }

  async function createOrganization() {
    if (state.mode !== 'supabase') return alert('Organisasjoner krever Supabase-modus.');
    const name = $('organization-name').value.trim();
    if (!name) return;
    const { data, error } = await state.supabase
      .from('organizations')
      .insert({ name, created_by: state.user.id })
      .select('id')
      .single();
    if (error) throw error;
    $('organization-name').value = '';
    state.organizationPickerOpen = false;
    await loadOrganizations();
    if (data?.id) await selectOrganization(data.id);
  }

  async function selectOrganization(id) {
    state.selectedOrganization = state.organizations.find(org => org.id === id) || null;
    if (!state.selectedOrganization) return;
    localStorage.setItem(SELECTED_ORG_STORAGE_KEY, state.selectedOrganization.id);
    state.organizationPickerOpen = false;
    setWorkspaceVisible(true);
    await loadProjectSettings();
    await loadRebuses();
    await loadAccessManagement();
    renderOrganizations();
    configureMapsUi();
  }

  function renderOrganizations() {
    setWorkspaceVisible(Boolean(state.selectedOrganization));
    const activeOrgMarkup = state.selectedOrganization
      ? `<strong>${escapeHtml(state.selectedOrganization.name)}</strong><p class="muted">Aktiv organisasjon</p>`
      : '<p class="muted">Ingen organisasjon valgt.</p>';
    if ($('selected-organization-card')) $('selected-organization-card').innerHTML = activeOrgMarkup;
    if ($('organization-settings-card')) $('organization-settings-card').hidden = state.mode !== 'supabase' || !state.selectedOrganization;
    if ($('organization-invite-card')) $('organization-invite-card').hidden = state.mode !== 'supabase' || !state.selectedOrganization;
    if ($('project-settings-card')) $('project-settings-card').hidden = state.mode !== 'supabase' || !state.selectedOrganization;
    if ($('toggle-organization-picker-button')) $('toggle-organization-picker-button').textContent = state.organizationPickerOpen ? 'Lukk orgvalg' : 'Bytt org';
    if ($('organization-picker')) $('organization-picker').hidden = !state.organizationPickerOpen;

    const organizationButtons = state.organizations.length
      ? state.organizations.map(org => `
        <button class="ghost" data-org-id="${escapeHtml(org.id)}">
          ${state.selectedOrganization?.id === org.id ? '✓ ' : ''}${escapeHtml(org.name)}
        </button>
      `).join('')
      : '<p class="muted">Du har ingen organisasjoner ennå. Be en admin invitere deg, eller opprett en egen organisasjon.</p>';
    if ($('organization-list')) $('organization-list').innerHTML = organizationButtons;
    if ($('organization-choice-list')) $('organization-choice-list').innerHTML = organizationButtons;
    renderAccessManagement();

    document.querySelectorAll('[data-org-id]').forEach(button => {
      button.addEventListener('click', () => selectOrganization(button.dataset.orgId).catch(error => alert(error.message)));
    });
  }

  function toggleOrganizationPicker() {
    state.organizationPickerOpen = !state.organizationPickerOpen;
    renderOrganizations();
  }

  function returnToOrganizationChoice() {
    localStorage.removeItem(SELECTED_ORG_STORAGE_KEY);
    state.selectedOrganization = null;
    state.projectSettings = null;
    state.rebuses = [];
    state.selectedRebus = null;
    state.organizationPickerOpen = false;
    renderOrganizations();
    renderRebusList();
    renderEmptyRebus();
  }

  async function loadProjectSettings() {
    if (state.mode !== 'supabase' || !state.selectedOrganization) return;
    const { data, error } = await state.supabase
      .from('project_settings')
      .select('*')
      .eq('organization_id', state.selectedOrganization.id)
      .maybeSingle();
    if (error) throw error;
    state.projectSettings = data;
    $('org-maps-key').value = data?.google_maps_api_key || '';
  }

  async function saveProjectSettings() {
    if (state.mode !== 'supabase' || !state.selectedOrganization) return alert('Velg organisasjon først.');
    const { data, error } = await state.supabase
      .from('project_settings')
      .upsert({
        organization_id: state.selectedOrganization.id,
        google_maps_api_key: $('org-maps-key').value.trim() || null
      })
      .select()
      .single();
    if (error) throw error;
    state.projectSettings = data;
    configureMapsUi(true);
  }

  async function inviteOrganizationAdmin() {
    if (state.mode !== 'supabase' || !state.selectedOrganization) return alert('Velg organisasjon først.');
    const email = (($('access-org-invite-email')?.value || $('org-invite-email')?.value || '').trim()).toLowerCase();
    const role = $('access-org-invite-role')?.value || $('org-invite-role')?.value || 'teacher';
    if (!email) return alert('Skriv inn e-post først.');
    const { error } = await state.supabase
      .from('organization_invitations')
      .upsert({
        organization_id: state.selectedOrganization.id,
        email,
        role,
        invited_by: state.user.id,
        accepted_at: null
      }, { onConflict: 'organization_id,email' });
    if (error) throw error;
    if ($('org-invite-email')) $('org-invite-email').value = '';
    if ($('access-org-invite-email')) $('access-org-invite-email').value = '';
    await loadAccessManagement();
    showNotification('Invitasjon lagret', `${email} får tilgang til organisasjonen når hen logger inn.`);
  }

  async function inviteRebusAdmin() {
    if (state.mode !== 'supabase' || !state.selectedRebus) return alert('Velg en rebus først.');
    const email = (($('access-rebus-invite-email')?.value || $('rebus-invite-email')?.value || '').trim()).toLowerCase();
    if (!email) return alert('Skriv inn e-post først.');
      const { error } = await state.supabase
        .from('rebus_invitations')
        .upsert({
          rebus_id: state.selectedRebus.id,
          email,
          role: $('access-rebus-invite-role')?.value || $('rebus-invite-role')?.value || 'teacher',
          invited_by: state.user.id,
          accepted_at: null
        }, { onConflict: 'rebus_id,email' });
    if (error) throw error;
    if ($('rebus-invite-email')) $('rebus-invite-email').value = '';
    if ($('access-rebus-invite-email')) $('access-rebus-invite-email').value = '';
    await loadAccessManagement();
    showNotification('Rebus-invitasjon lagret', `${email} får admin-tilgang bare til denne rebusen.`);
  }

  async function loadAccessManagement() {
    if (state.mode !== 'supabase' || !state.selectedOrganization) {
      state.access = { orgMembers: [], orgInvites: [], rebusAdmins: [], rebusInvites: [] };
      renderAccessManagement();
      return;
    }

    const [{ data: orgMembers, error: membersError }, { data: orgInvites, error: invitesError }] = await Promise.all([
      state.supabase
        .from('organization_members')
        .select('organization_id, user_id, role, created_at')
        .eq('organization_id', state.selectedOrganization.id)
        .order('created_at', { ascending: true }),
      state.supabase
        .from('organization_invitations')
        .select('id, email, role, accepted_at, created_at')
        .eq('organization_id', state.selectedOrganization.id)
        .order('created_at', { ascending: false })
    ]);
    if (membersError) throw membersError;
    if (invitesError) throw invitesError;

    let rebusAdmins = [];
    let rebusInvites = [];
    if (state.selectedRebus) {
      const [{ data: adminsData, error: adminsError }, { data: rebusInvitesData, error: rebusInvitesError }] = await Promise.all([
        state.supabase
          .from('rebus_admins')
          .select('rebus_id, user_id, created_at')
          .eq('rebus_id', state.selectedRebus.id)
          .order('created_at', { ascending: true }),
        state.supabase
          .from('rebus_invitations')
          .select('id, email, role, accepted_at, created_at')
          .eq('rebus_id', state.selectedRebus.id)
          .order('created_at', { ascending: false })
      ]);
      if (adminsError) throw adminsError;
      if (rebusInvitesError) throw rebusInvitesError;
      rebusAdmins = adminsData || [];
      rebusInvites = rebusInvitesData || [];
    }

    const profileIds = [...new Set([
      ...(orgMembers || []).map(item => item.user_id),
      ...(rebusAdmins || []).map(item => item.user_id)
    ].filter(Boolean))];
    const profilesById = await loadProfilesById(profileIds);
    state.access = {
      orgMembers: (orgMembers || []).map(item => ({ ...item, profile: profilesById.get(item.user_id) })),
      orgInvites: orgInvites || [],
      rebusAdmins: (rebusAdmins || []).map(item => ({ ...item, profile: profilesById.get(item.user_id) })),
      rebusInvites
    };
    renderAccessManagement();
  }

  async function loadProfilesById(ids) {
    const profilesById = new Map();
    if (!ids.length) return profilesById;
    const { data, error } = await state.supabase
      .from('profiles')
      .select('id, email, full_name, nickname')
      .in('id', ids);
    if (error) throw error;
    (data || []).forEach(profile => profilesById.set(profile.id, profile));
    return profilesById;
  }

  function renderAccessManagement() {
    const orgRoot = $('organization-access-list');
    const rebusRoot = $('rebus-access-list');
    if (orgRoot) {
      orgRoot.innerHTML = state.selectedOrganization ? `
        <div class="access-section">
          <h4>Aktive i organisasjonen</h4>
          ${state.access.orgMembers.length ? state.access.orgMembers.map(renderOrgAccessRow).join('') : '<p class="muted">Ingen medlemmer funnet ennå.</p>'}
        </div>
        <div class="access-section">
          <h4>Invitasjoner</h4>
          ${state.access.orgInvites.length ? state.access.orgInvites.map(renderInviteRow).join('') : '<p class="muted">Ingen åpne invitasjoner.</p>'}
        </div>
      ` : '<p class="muted">Velg organisasjon først.</p>';
    }
    if (rebusRoot) {
      rebusRoot.innerHTML = state.selectedRebus ? `
        <div class="access-section">
          <h4>Direkte tilgang til ${escapeHtml(state.selectedRebus.title || 'rebusen')}</h4>
          ${state.access.rebusAdmins.length ? state.access.rebusAdmins.map(renderRebusAccessRow).join('') : '<p class="muted">Ingen har direkte rebus-tilgang ennå.</p>'}
        </div>
        <div class="access-section">
          <h4>Invitasjoner til rebusen</h4>
          ${state.access.rebusInvites.length ? state.access.rebusInvites.map(renderInviteRow).join('') : '<p class="muted">Ingen åpne rebus-invitasjoner.</p>'}
        </div>
      ` : '<p class="muted">Velg en rebus først, så kan du invitere bare til den rebusen.</p>';
    }
  }

  function renderOrgAccessRow(member) {
    const profile = member.profile || {};
    return `
      <article class="access-row">
        <div>
          <strong>${escapeHtml(profile.nickname || profile.full_name || profile.email || member.user_id)}</strong>
          <p class="muted">${escapeHtml(profile.email || '')}</p>
        </div>
        <span class="status-pill submitted">${roleLabel(member.role)}</span>
      </article>
    `;
  }

  function renderRebusAccessRow(member) {
    const profile = member.profile || {};
    return `
      <article class="access-row">
        <div>
          <strong>${escapeHtml(profile.nickname || profile.full_name || profile.email || member.user_id)}</strong>
          <p class="muted">${escapeHtml(profile.email || '')}</p>
        </div>
        <span class="status-pill submitted">Rebus-admin</span>
      </article>
    `;
  }

  function renderInviteRow(invite) {
    return `
      <article class="access-row">
        <div>
          <strong>${escapeHtml(invite.email)}</strong>
          <p class="muted">${invite.accepted_at ? 'Akseptert' : 'Venter på innlogging med samme e-post'}</p>
        </div>
        <span class="status-pill ${invite.accepted_at ? 'success' : 'pending'}">${roleLabel(invite.role)}</span>
      </article>
    `;
  }

  function roleLabel(role) {
    const labels = { owner: 'Eier', admin: 'Admin', teacher: 'Lærer', viewer: 'Lesetilgang' };
    return labels[role] || role || 'Tilgang';
  }

  function currentMapsKey() {
    if (state.mode === 'supabase') return state.projectSettings?.google_maps_api_key || '';
    return state.projectSettings?.google_maps_api_key || state.config.googleMapsApiKey || '';
  }

  function configureMapsUi(forceReload = false) {
    const mapsKey = currentMapsKey();
    if (!mapsKey) {
      $('maps-status').textContent = 'Google Maps API-nøkkel mangler. Legg inn nøkkel på organisasjonen, eller fyll koordinater manuelt.';
      return;
    }
    if (state.loadedMapsKey === mapsKey && !forceReload) return;

    const mapsUrl = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(mapsKey)}&libraries=places`;
    loadScript(mapsUrl, forceReload ? 'google-maps-script' : null)
      .then(() => {
        state.loadedMapsKey = mapsKey;
        initMapPicker();
      })
      .catch(() => {
        $('maps-status').textContent = 'Kunne ikke laste Google Maps. Manuell koordinatmodus er aktiv.';
      });
  }

  function initMapPicker() {
    const fallbackCenter = { lat: 60.79823355219047, lng: 10.674827839521527 };
    const existingLocation = currentLocationFields();
    const initialCenter = existingLocation || fallbackCenter;
    const mapElement = $('task-map');
    mapElement.classList.add('is-live');
    mapElement.textContent = '';

    state.map = new google.maps.Map(mapElement, {
      center: initialCenter,
      zoom: 15,
      mapTypeControl: true,
      streetViewControl: false,
      fullscreenControl: true
    });

    state.marker = new google.maps.Marker({
      map: state.map,
      position: initialCenter,
      draggable: true
    });
    if (existingLocation) {
      setPickedLocation(existingLocation.lat, existingLocation.lng, $('task-location-label').value);
      focusMapOnLocation(existingLocation.lat, existingLocation.lng);
    } else {
      setLocationFields(fallbackCenter.lat, fallbackCenter.lng, 'Fastland');
    }

    state.map.addListener('click', event => {
      setPickedLocation(event.latLng.lat(), event.latLng.lng(), $('task-location-label').value);
    });
    state.marker.addListener('dragend', event => {
      setPickedLocation(event.latLng.lat(), event.latLng.lng(), $('task-location-label').value);
    });

    if (google.maps.places && google.maps.places.Autocomplete) {
      state.autocomplete = new google.maps.places.Autocomplete($('place-search'), {
        fields: ['geometry', 'name', 'formatted_address']
      });
      state.autocomplete.addListener('place_changed', () => {
        const place = state.autocomplete.getPlace();
        if (!place.geometry || !place.geometry.location) return;
        const label = place.name || place.formatted_address || '';
        setPickedLocation(place.geometry.location.lat(), place.geometry.location.lng(), label);
        state.map.panTo(place.geometry.location);
        state.map.setZoom(17);
      });
    }

    $('maps-status').textContent = 'Kartvelger aktiv. Søk etter sted, klikk i kartet eller dra markøren.';
  }

  function setPickedLocation(lat, lng, label) {
    setLocationFields(lat, lng, label);
    if (state.marker) state.marker.setPosition({ lat, lng });
  }

  function focusMapOnLocation(lat, lng) {
    if (!state.map || !Number.isFinite(lat) || !Number.isFinite(lng)) return;
    state.map.panTo({ lat, lng });
    state.map.setZoom(17);
    if (state.marker) state.marker.setPosition({ lat, lng });
  }

  function setLocationFields(lat, lng, label) {
    $('task-lat').value = Number(lat).toFixed(7);
    $('task-lng').value = Number(lng).toFixed(7);
    if (label) $('task-location-label').value = label;
  }

  function currentLocationFields() {
    const lat = parseCoordinate($('task-lat').value);
    const lng = parseCoordinate($('task-lng').value);
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
  }

  function parseCoordinate(value) {
    const trimmed = String(value ?? '').trim();
    if (!trimmed) return NaN;
    return Number(trimmed);
  }

  function useCurrentLocation() {
    if (!navigator.geolocation) return alert('Nettleseren støtter ikke posisjon.');
    navigator.geolocation.getCurrentPosition(position => {
      const lat = position.coords.latitude;
      const lng = position.coords.longitude;
      setPickedLocation(lat, lng, 'Min posisjon');
      if (state.map) {
        state.map.panTo({ lat, lng });
        state.map.setZoom(17);
      }
    }, () => alert('Kunne ikke hente posisjonen din.'), { enableHighAccuracy: true, timeout: 12000 });
  }

  async function loadRebuses() {
    if (state.mode === 'supabase') return loadSupabaseRebuses();
    const data = await localApi('/api/admin/rebuses');
    state.rebuses = data.rebuses || [];
    $('rebus-count').textContent = String(state.rebuses.length);
    renderRebusList();
  }

  async function loadSupabaseRebuses() {
    if (!state.selectedOrganization) {
      state.rebuses = [];
      renderRebusList();
      return;
    }
    const { data, error } = await state.supabase
      .from('rebuses')
      .select('*, tasks(id), students(id)')
      .eq('organization_id', state.selectedOrganization.id)
      .order('created_at', { ascending: true });
    if (error) throw error;
    state.rebuses = (data || []).map(rebus => ({
      ...rebus,
      taskCount: rebus.tasks?.length || 0,
      studentCount: rebus.students?.length || 0
    }));
    $('rebus-count').textContent = String(state.rebuses.length);
    renderRebusList();
  }

  async function selectRebus(id) {
    if (state.mode === 'supabase') {
      const { data, error } = await state.supabase
        .from('rebuses')
        .select('*, rebus_stops(*), tasks(*, task_options(*), task_assets(*), task_hints(*)), students(id, display_name, username, password_hash, team_name, created_at, student_task_overrides(task_id, is_skipped), progress(id, task_id, answer, status, correct, points_awarded, created_at), submissions(id, task_id, type, storage_bucket, storage_path, original_name, content_type, size_bytes, note, status, created_at), locations(latitude, longitude, accuracy, created_at), group_score_adjustments(id, points, reason, created_at))')
        .eq('id', id)
        .single();
      if (error) throw error;
      state.selectedRebus = normalizeSupabaseRebus(data);
      await loadGroupMessages({ notify: false, rerender: false });
      await loadAccessManagement();
    } else {
      const data = await localApi(`/api/admin/rebuses/${id}`);
      state.selectedRebus = data.rebus;
      state.groupMessages = [];
    }
    if (localStorage.getItem('orgSidebarManual') !== 'true') {
      state.orgSidebarCollapsed = true;
      localStorage.setItem('orgSidebarCollapsed', 'true');
      applyOrgSidebarState();
    }
    renderSelectedRebus();
    renderStopSelect();
  }

  function normalizeSupabaseRebus(rebus) {
    return {
      ...rebus,
      title: rebus.title,
      description: rebus.description,
      stops: (rebus.rebus_stops || []).sort((a, b) => a.sort_order - b.sort_order),
      tasks: (rebus.tasks || []).sort((a, b) => a.sort_order - b.sort_order).map(task => ({
        ...task,
        order: task.sort_order,
        geofenceRadiusMeters: task.geofence_radius_meters,
        options: (task.task_options || []).sort((a, b) => a.sort_order - b.sort_order),
        assets: (task.task_assets || []).sort((a, b) => a.sort_order - b.sort_order),
        hints: (task.task_hints || []).sort((a, b) => a.sort_order - b.sort_order),
        location: Number.isFinite(task.latitude) && Number.isFinite(task.longitude)
          ? { lat: task.latitude, lng: task.longitude, label: task.location_label }
          : null
      })),
      students: (rebus.students || []).map(student => ({
        ...student,
        displayName: student.display_name,
        teamName: student.team_name,
        password: visiblePassword(student.password_hash),
        taskOverrides: student.student_task_overrides || [],
        progress: student.progress || [],
        submissions: student.submissions || [],
        locations: student.locations || [],
        scoreAdjustments: student.group_score_adjustments || []
      }))
    };
  }

  function renderRebusList() {
    $('rebus-list').innerHTML = state.rebuses.length
      ? state.rebuses.map(rebus => `
        <button class="ghost" data-rebus-id="${escapeHtml(rebus.id)}">
          ${rebus.status === 'published' ? 'Aktiv' : 'Pauset'} · ${escapeHtml(rebus.title)} · ${escapeHtml(rebus.rebus_code || 'ingen kode')} (${rebus.taskCount || 0} oppgaver, ${rebus.studentCount || 0} elever)
        </button>
      `).join('')
      : '<p class="muted">Ingen rebuser ennå.</p>';

    document.querySelectorAll('[data-rebus-id]').forEach(button => {
      button.addEventListener('click', () => selectRebus(button.dataset.rebusId).catch(error => alert(error.message)));
    });
  }

  function renderSelectedRebus() {
    const rebus = state.selectedRebus;
    if (!rebus) return;
    $('selected-title').textContent = rebus.title;
    $('selected-description').textContent = rebus.description || 'Ingen beskrivelse.';
    $('rebus-settings').hidden = false;
    $('edit-rebus-title').value = rebus.title || '';
    $('edit-rebus-description').value = rebus.description || '';
    $('edit-rebus-code').value = rebus.rebus_code || suggestedRebusCode(rebus.title);
    $('edit-rebus-status').value = rebus.status || 'draft';
    $('edit-rebus-show-score').checked = rebus.show_live_score !== false && rebus.showLiveScore !== false;
    $('task-list').innerHTML = rebus.tasks.length
      ? renderTasksGroupedByStop(rebus)
      : '<p class="muted">Ingen oppgaver ennå. Trykk “Ny oppgave” for å lage den første. Første oppgave blir start, siste blir mål.</p>';
    renderGroupList();
    renderSubmissionList();
    renderChatTab();
    renderChatSidebar();
    renderAccessManagement();
    setDefaultGroupFields();
    bindTaskListActions();
  }

  function renderEmptyRebus() {
    $('selected-title').textContent = 'Velg en rebus';
    $('selected-description').textContent = 'Når en rebus er valgt kan du legge til oppgaver, grupper og se live status.';
    $('rebus-settings').hidden = true;
    $('task-list').innerHTML = '';
    $('group-list').innerHTML = '';
    $('submission-list').innerHTML = '';
    $('chat-panel').innerHTML = '';
    renderChatSidebar();
    renderAccessManagement();
    $('live-body').innerHTML = '<tr><td colspan="7" class="muted">Velg en rebus først.</td></tr>';
    renderStopSelect();
  }

  function renderGroupList() {
    const students = state.selectedRebus?.students || [];
    const messagesByStudent = groupMessagesByStudent();
    $('group-list').innerHTML = students.length
      ? students.map(student => {
        const groupName = groupDisplayName(student);
        const username = student.username || '';
        const password = groupPassword(student);
        const suggestedPassword = password || generateAccessCode();
        const messages = messagesByStudent.get(student.id) || [];
        const unreadCount = messages.filter(message => message.sender_type === 'student' && !message.read_by_admin_at).length;
        const stats = groupStats(student);
        const expanded = state.expandedGroupId === student.id;
        return `
          <article class="task-card group-card compact-group-card ${password ? '' : 'missing-code'}">
            <div class="group-summary">
              <div>
                <h3>${escapeHtml(groupName)}</h3>
                <p class="muted">Brukernavn: <code>${escapeHtml(username || '-')}</code> · Kode: <code>${escapeHtml(password || suggestedPassword)}</code></p>
              </div>
              <dl class="group-login-details">
                <div><dt>Score</dt><dd><strong>${stats.totalScore}</strong></dd></div>
                <div><dt>Fullført</dt><dd>${stats.completedCount}/${state.selectedRebus.tasks.length}</dd></div>
                <div><dt>Siste svar</dt><dd>${formatClock(stats.latestProgressAt)}</dd></div>
                <div><dt>Meldinger</dt><dd>${unreadCount ? `<span class="badge-alert">${unreadCount} ny</span>` : messages.length}</dd></div>
              </dl>
              ${password ? '' : '<p class="notice compact-notice">Denne gruppen manglet kode. Ny kode er foreslått i feltet til høyre. Trykk “Lagre kode”.</p>'}
            </div>
            <div class="group-card-actions">
              <button class="compact" type="button" data-toggle-group-details="${escapeHtml(student.id)}">${expanded ? 'Skjul detaljer' : 'Detaljer'}</button>
              <button class="ghost compact" type="button" data-copy-login="${escapeHtml(student.id)}">Kopier login</button>
            </div>
            ${expanded ? renderGroupDetails(student, suggestedPassword) : ''}
          </article>
        `;
      }).join('')
      : '<p class="muted">Ingen grupper ennå.</p>';

    document.querySelectorAll('[data-generate-password]').forEach(button => {
      button.addEventListener('click', () => {
        const input = document.querySelector(`[data-group-password="${cssEscape(button.dataset.generatePassword)}"]`);
        if (input) input.value = generateAccessCode();
      });
    });
    document.querySelectorAll('[data-save-password]').forEach(button => {
      button.addEventListener('click', () => updateGroupPassword(button.dataset.savePassword).catch(error => alert(error.message)));
    });
    document.querySelectorAll('[data-copy-login]').forEach(button => {
      button.addEventListener('click', () => copyGroupLogin(button.dataset.copyLogin).catch(error => alert(error.message)));
    });
    document.querySelectorAll('[data-toggle-group-details]').forEach(button => {
      button.addEventListener('click', () => {
        state.expandedGroupId = state.expandedGroupId === button.dataset.toggleGroupDetails ? null : button.dataset.toggleGroupDetails;
        renderGroupList();
      });
    });
    document.querySelectorAll('[data-save-group]').forEach(button => {
      button.addEventListener('click', () => updateGroup(button.dataset.saveGroup).catch(error => alert(error.message)));
    });
    document.querySelectorAll('[data-delete-group]').forEach(button => {
      button.addEventListener('click', () => deleteGroup(button.dataset.deleteGroup).catch(error => alert(error.message)));
    });
    $('group-list').querySelectorAll('[data-send-admin-message]').forEach(button => {
      button.addEventListener('click', () => sendAdminMessage(button.dataset.sendAdminMessage, button).catch(error => alert(error.message)));
    });
    document.querySelectorAll('[data-admin-message]').forEach(input => {
      input.addEventListener('input', () => {
        state.adminMessageDrafts.set(input.dataset.adminMessage, input.value);
      });
    });
    document.querySelectorAll('[data-save-route]').forEach(button => {
      button.addEventListener('click', () => saveGroupRoute(button.dataset.saveRoute).catch(error => alert(error.message)));
    });
    document.querySelectorAll('[data-send-to-goal]').forEach(button => {
      button.addEventListener('click', () => sendGroupToGoal(button.dataset.sendToGoal).catch(error => alert(error.message)));
    });
    document.querySelectorAll('[data-adjust-score]').forEach(button => {
      button.addEventListener('click', () => adjustGroupScore(button.dataset.adjustScore).catch(error => alert(error.message)));
    });
    bindSubmissionActions($('group-list'));
  }

  function renderGroupDetails(student, suggestedPassword) {
    const groupName = groupDisplayName(student);
    const password = groupPassword(student);
    return `
      <section class="group-detail-panel">
        <div class="group-detail-grid">
          ${renderGroupProgressDetails(student)}
          ${renderGroupScoreAdjustments(student)}
        </div>
        ${renderGroupSubmissions(student)}
        ${renderGroupRouteTools(student)}
        <section class="group-edit-box">
          <h3>Rediger gruppe</h3>
          <div class="form-grid">
            <label><span>Gruppenavn</span><input data-group-name="${escapeHtml(student.id)}" value="${escapeHtml(groupName)}"></label>
            <label><span>Brukernavn</span><input data-group-username="${escapeHtml(student.id)}" value="${escapeHtml(student.username || '')}"></label>
            <label><span>Ny kode</span><input data-group-password="${escapeHtml(student.id)}" value="${password ? '' : escapeHtml(suggestedPassword)}" placeholder="Ny kode"></label>
          </div>
          <div class="actions">
            <button class="ghost compact" type="button" data-generate-password="${escapeHtml(student.id)}">Generer kode</button>
            <button class="compact" type="button" data-save-password="${escapeHtml(student.id)}">Lagre kode</button>
            <button class="ghost compact" type="button" data-save-group="${escapeHtml(student.id)}">Lagre gruppe</button>
            <button class="danger compact" type="button" data-delete-group="${escapeHtml(student.id)}">Slett gruppe</button>
          </div>
        </section>
        <section class="score-adjust-box">
          <h3>Straff eller belønning</h3>
          <div class="form-grid">
            <label><span>Poeng (-5 til +5)</span><input data-adjust-points="${escapeHtml(student.id)}" type="number" min="-5" max="5" value="1"></label>
            <label><span>Begrunnelse</span><input data-adjust-reason="${escapeHtml(student.id)}" placeholder="F.eks. god lagånd eller regelbrudd"></label>
          </div>
          <button class="compact" type="button" data-adjust-score="${escapeHtml(student.id)}">Gi straff/belønning</button>
        </section>
      </section>
    `;
  }

  function groupStats(student) {
    const progress = sortedProgress(student);
    const adjustments = student.scoreAdjustments || student.group_score_adjustments || [];
    const completed = progress.filter(item => item.correct !== false);
    const taskScore = progress.reduce((sum, item) => sum + Number(item.points_awarded ?? item.pointsAwarded ?? 0), 0);
    const adjustmentScore = adjustments.reduce((sum, item) => sum + Number(item.points || 0), 0);
    return {
      progress,
      completed,
      completedCount: completed.length,
      taskScore,
      adjustmentScore,
      totalScore: taskScore + adjustmentScore,
      latestProgressAt: completed[completed.length - 1]?.created_at || completed[completed.length - 1]?.createdAt || null
    };
  }

  function sortedProgress(student) {
    return [...(student.progress || [])].sort((a, b) => new Date(a.created_at || a.createdAt) - new Date(b.created_at || b.createdAt));
  }

  function renderGroupProgressDetails(student) {
    const stats = groupStats(student);
    const tasksById = new Map((state.selectedRebus?.tasks || []).map(task => [task.id, task]));
    const completed = stats.completed;
    const rows = completed.length ? completed.map((item, index) => {
      const task = tasksById.get(item.task_id || item.taskId);
      const previous = completed[index - 1];
      const travelMinutes = previous
        ? minutesBetween(previous.created_at || previous.createdAt, item.created_at || item.createdAt)
        : null;
      return `
        <tr>
          <td>${escapeHtml(task?.title || 'Ukjent oppgave')}</td>
          <td>${formatClock(item.created_at || item.createdAt)}</td>
          <td>${travelMinutes === null ? '-' : formatMinutes(travelMinutes)}</td>
          <td>
            <div class="manual-score-inline">
              <span>${Number(item.points_awarded ?? item.pointsAwarded ?? 0)}</span>
              ${item.id ? `
                <input data-manual-points="${escapeHtml(item.id)}" type="number" min="0" max="${Number(task?.points || 20)}" value="${Number(item.points_awarded ?? item.pointsAwarded ?? 0)}" aria-label="Poeng">
                <button class="ghost tiny-button" type="button" data-save-manual-score="${escapeHtml(item.id)}">Lagre</button>
              ` : ''}
            </div>
          </td>
          <td>${formatProgressAnswer(item.answer || '')}</td>
        </tr>
      `;
    }).join('') : '<tr><td colspan="5" class="muted">Ingen poster fullført ennå.</td></tr>';
    const latestLocation = latestStudentLocation(student);
    return `
      <section class="group-info-box">
        <h3>Detaljert progresjon</h3>
        <div class="mini-stats">
          <div><span>Oppgavepoeng</span><strong>${stats.taskScore}</strong></div>
          <div><span>Justeringer</span><strong>${signedNumber(stats.adjustmentScore)}</strong></div>
          <div><span>Total</span><strong>${stats.totalScore}</strong></div>
          <div><span>Siste GPS</span><strong>${latestLocation ? formatClock(latestLocation.created_at) : '-'}</strong></div>
        </div>
        <table class="mini-table">
          <thead><tr><th>Post</th><th>Tid</th><th>Fra forrige</th><th>Poeng</th><th>Svar</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </section>
    `;
  }

  function renderGroupScoreAdjustments(student) {
    const adjustments = [...(student.scoreAdjustments || student.group_score_adjustments || [])]
      .sort((a, b) => new Date(b.created_at || b.createdAt) - new Date(a.created_at || a.createdAt));
    return `
      <section class="group-info-box">
        <h3>Poengjusteringer</h3>
        ${adjustments.length ? adjustments.slice(0, 6).map(item => `
          <div class="adjustment-line ${Number(item.points) > 0 ? 'reward-line' : 'penalty-line'}">
            <strong>${signedNumber(item.points)} poeng</strong>
            <span>${escapeHtml(item.reason || 'Ingen begrunnelse')}</span>
            <small>${formatClock(item.created_at || item.createdAt)}</small>
          </div>
        `).join('') : '<p class="muted">Ingen straff eller belønninger gitt.</p>'}
      </section>
    `;
  }

  function renderGroupSubmissions(student) {
    const submissions = sortedSubmissions(student);
    return `
      <section class="group-info-box">
        <div class="builder-heading">
          <h3>Media levert av ${escapeHtml(groupDisplayName(student))}</h3>
          <button class="ghost compact" type="button" data-admin-tab-jump="submissions">Se alle innleveringer</button>
        </div>
        ${submissions.length ? submissions.map(submission => renderSubmissionCard(submission, student)).join('') : '<p class="muted">Ingen media levert ennå.</p>'}
      </section>
    `;
  }

  function renderSubmissionList() {
    const list = $('submission-list');
    if (!list) return;
    const rows = allSubmissionRows();
    list.innerHTML = rows.length
      ? rows.map(({ student, submission }) => renderSubmissionCard(submission, student)).join('')
      : '<p class="muted">Ingen media-innleveringer ennå.</p>';
    bindSubmissionActions(list);
  }

  async function refreshSelectedRebusForSubmissions() {
    if (state.mode !== 'supabase' || !state.selectedRebus?.id) return;
    await selectRebus(state.selectedRebus.id);
  }

  function allSubmissionRows() {
    const students = state.selectedRebus?.students || [];
    return students.flatMap(student => sortedSubmissions(student).map(submission => ({ student, submission })))
      .sort((a, b) => new Date(b.submission.created_at || b.submission.createdAt) - new Date(a.submission.created_at || a.submission.createdAt));
  }

  function renderSubmissionCard(submission, student) {
    const task = taskById(submission.task_id || submission.taskId);
    const progress = latestProgressForTask(student, submission.task_id || submission.taskId);
    const progressId = progress?.id || '';
    const currentPoints = Number(progress?.points_awarded ?? progress?.pointsAwarded ?? 0);
    const maxPoints = Number(task?.points || 20);
    const statusText = progress?.status === 'approved' || progress?.correct === true
      ? 'Vurdert'
      : 'Venter vurdering';
    return `
      <article class="submission-card">
        <div>
          <div class="submission-meta">
            <strong>${escapeHtml(groupDisplayName(student))}</strong>
            <span>${escapeHtml(task?.title || 'Ukjent oppgave')}</span>
            <span class="status-pill ${statusText === 'Vurdert' ? 'success' : 'pending'}">${statusText}</span>
          </div>
          <p><strong>${escapeHtml(submission.original_name || submission.originalName || submission.storage_path || 'Innlevering')}</strong></p>
          ${submission.note ? `<p class="muted">${escapeHtml(submission.note)}</p>` : ''}
          <p class="muted">${escapeHtml(submission.content_type || submission.contentType || 'fil')} · ${formatFileSize(submission.size_bytes || submission.sizeBytes)} · ${formatClock(submission.created_at || submission.createdAt)}</p>
        </div>
        <div class="submission-actions">
          <button
            class="ghost compact"
            type="button"
            data-open-submission="${escapeHtml(submission.storage_path || submission.storagePath || '')}"
            data-submission-type="${escapeHtml(submission.content_type || submission.contentType || '')}"
            data-submission-name="${escapeHtml(submission.original_name || submission.originalName || 'Innlevering')}"
          >Åpne</button>
          <label><span>Poeng</span><input data-manual-points="${escapeHtml(progressId)}" type="number" min="0" max="${maxPoints}" value="${currentPoints}"></label>
          <button class="compact" type="button" data-save-manual-score="${escapeHtml(progressId)}" ${progressId ? '' : 'disabled'}>Lagre poeng</button>
        </div>
      </article>
    `;
  }

  function bindSubmissionActions(root = document) {
    root.querySelectorAll('[data-open-submission]').forEach(button => {
      button.addEventListener('click', () => openSubmission(button).catch(error => alert(error.message)));
    });
    root.querySelectorAll('[data-save-manual-score]').forEach(button => {
      button.addEventListener('click', () => saveManualScore(button.dataset.saveManualScore, button).catch(error => alert(error.message)));
    });
    root.querySelectorAll('[data-admin-tab-jump]').forEach(button => {
      button.addEventListener('click', () => switchAdminTab(button.dataset.adminTabJump));
    });
  }

  function sortedSubmissions(student) {
    return [...(student.submissions || [])].sort((a, b) => new Date(b.created_at || b.createdAt) - new Date(a.created_at || a.createdAt));
  }

  function latestProgressForTask(student, taskId) {
    const rows = (student.progress || []).filter(item => (item.task_id || item.taskId) === taskId);
    return rows.sort((a, b) => new Date(b.created_at || b.createdAt) - new Date(a.created_at || a.createdAt))[0] || null;
  }

  function taskById(taskId) {
    return (state.selectedRebus?.tasks || []).find(task => task.id === taskId) || null;
  }

  function formatFileSize(bytes) {
    const size = Number(bytes || 0);
    if (!size) return 'ukjent størrelse';
    if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
    return `${(size / 1024 / 1024).toFixed(1)} MB`;
  }

  function submissionFileName(submission, student, index = 0) {
    const task = taskById(submission.task_id || submission.taskId);
    const deliveredAt = submission.created_at || submission.createdAt || new Date().toISOString();
    const stamp = new Date(deliveredAt).toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const originalName = submission.original_name || submission.originalName || submission.storage_path || 'innlevering';
    const extensionMatch = String(originalName).match(/(\.[a-z0-9]{1,8})$/i);
    const extension = extensionMatch ? extensionMatch[1].toLowerCase() : extensionFromContentType(submission.content_type || submission.contentType);
    const base = [
      String(index + 1).padStart(3, '0'),
      slugify(groupDisplayName(student)) || 'gruppe',
      slugify(task?.title || 'oppgave') || 'oppgave',
      stamp
    ].join('_');
    return `${base}${extension}`;
  }

  function extensionFromContentType(contentType) {
    const map = {
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/webp': '.webp',
      'image/heic': '.heic',
      'image/heif': '.heif',
      'video/mp4': '.mp4',
      'video/quicktime': '.mov',
      'video/webm': '.webm',
      'audio/mpeg': '.mp3',
      'audio/mp4': '.m4a',
      'audio/wav': '.wav',
      'audio/webm': '.webm',
      'audio/x-m4a': '.m4a',
      'audio/aac': '.aac',
      'audio/ogg': '.ogg'
    };
    return map[String(contentType || '').toLowerCase()] || '';
  }

  function formatProgressAnswer(answer) {
    const value = String(answer || '');
    if (value.startsWith('[GITT_OPP]')) return '<span class="status-pill retry">Gitt opp</span>';
    if (value.startsWith('[MEDIA_LEVERT]')) return `<span class="status-pill pending">Media levert</span> ${escapeHtml(value.replace('[MEDIA_LEVERT]', '').trim())}`;
    return escapeHtml(value);
  }

  function latestStudentLocation(student) {
    const locations = [...(student.locations || [])].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    return locations[locations.length - 1] || null;
  }

  function minutesBetween(start, end) {
    if (!start || !end) return null;
    return Math.max(0, Math.round((new Date(end) - new Date(start)) / 60000));
  }

  function signedNumber(value) {
    const number = Number(value || 0);
    return number > 0 ? `+${number}` : String(number);
  }

  function renderGroupRouteTools(student) {
    const tasks = state.selectedRebus?.tasks || [];
    if (!tasks.length) return '';
    const skipped = new Set((student.taskOverrides || student.student_task_overrides || []).filter(item => item.is_skipped).map(item => item.task_id || item.taskId));
    return `
      <section class="group-route-box">
        <div class="builder-heading">
          <h3>Styr løype</h3>
          <button class="ghost compact" type="button" data-send-to-goal="${escapeHtml(student.id)}">Send til mål</button>
        </div>
        <div class="route-task-grid">
          ${tasks.map((task, index) => `
            <label class="check-label route-check">
              <input type="checkbox" data-route-skip="${escapeHtml(student.id)}" value="${escapeHtml(task.id)}" ${skipped.has(task.id) ? 'checked' : ''}>
              Hopp over ${index === 0 ? 'Start' : index === tasks.length - 1 ? 'Mål' : `Oppgave ${index + 1}`}: ${escapeHtml(task.title)}
            </label>
          `).join('')}
        </div>
        <p class="muted">Avhukede oppgaver skjules bare for denne gruppa. Neste synlige post blir målet deres.</p>
        <button class="ghost compact" type="button" data-save-route="${escapeHtml(student.id)}">Lagre løype for gruppa</button>
      </section>
    `;
  }

  function renderAdminMessage(message) {
    const mine = message.sender_type === 'admin';
    const sender = mine ? (message.sender_label || 'Lærer') : 'Gruppe';
    return `
      <div class="message-bubble ${mine ? 'message-admin' : 'message-student'}">
        <strong>${escapeHtml(sender)}</strong>
        <p>${escapeHtml(message.body)}</p>
        <small>${formatClock(message.created_at)}</small>
      </div>
    `;
  }

  function groupMessagesByStudent() {
    const grouped = new Map();
    state.groupMessages.forEach(message => {
      if (!grouped.has(message.student_id)) grouped.set(message.student_id, []);
      grouped.get(message.student_id).push(message);
    });
    return grouped;
  }

  function renderChatTab() {
    const panel = $('chat-panel');
    if (!panel) return;
    const students = sortedGroups();
    if (!students.length) {
      panel.innerHTML = '<p class="muted">Lag grupper før du bruker chat.</p>';
      return;
    }
    const messagesByStudent = groupMessagesByStudent();
    if (!state.activeChatStudentId || !students.some(student => student.id === state.activeChatStudentId)) {
      state.activeChatStudentId = students[0].id;
    }
    const activeStudent = students.find(student => student.id === state.activeChatStudentId);
    const activeMessages = messagesByStudent.get(state.activeChatStudentId) || [];
    panel.innerHTML = `
      <aside class="chat-roster">
        ${students.map(student => {
          const messages = messagesByStudent.get(student.id) || [];
          const unread = messages.filter(message => message.sender_type === 'student' && !message.read_by_admin_at).length;
          return `
            <button class="chat-roster-item ${student.id === state.activeChatStudentId ? 'active' : ''}" type="button" data-chat-student="${escapeHtml(student.id)}">
              <strong>${escapeHtml(groupDisplayName(student))}</strong>
              <span>${unread ? `${unread} ny` : `${messages.length} meldinger`}</span>
            </button>
          `;
        }).join('')}
      </aside>
      <section class="chat-thread-panel">
        <div class="builder-heading">
          <h3>${escapeHtml(groupDisplayName(activeStudent))}</h3>
          <button class="ghost compact" type="button" data-toggle-group-details="${escapeHtml(activeStudent.id)}">Åpne gruppedetaljer</button>
        </div>
        <div class="message-thread chat-thread">
          ${activeMessages.length ? activeMessages.map(renderAdminMessage).join('') : '<p class="muted">Ingen meldinger ennå.</p>'}
        </div>
        <div class="message-composer">
          <input data-chat-message="${escapeHtml(activeStudent.id)}" value="${escapeHtml(state.adminMessageDrafts.get(activeStudent.id) || '')}" placeholder="Skriv melding til ${escapeHtml(groupDisplayName(activeStudent))}">
          <button class="compact" type="button" data-send-admin-message="${escapeHtml(activeStudent.id)}">Send</button>
        </div>
      </section>
    `;

    document.querySelectorAll('[data-chat-student]').forEach(button => {
      button.addEventListener('click', () => {
        state.activeChatStudentId = button.dataset.chatStudent;
        renderChatTab();
      });
    });
    document.querySelectorAll('[data-chat-message]').forEach(input => {
      input.addEventListener('input', () => {
        state.adminMessageDrafts.set(input.dataset.chatMessage, input.value);
      });
    });
    document.querySelectorAll('#chat-panel [data-send-admin-message]').forEach(button => {
      button.addEventListener('click', () => sendAdminMessage(button.dataset.sendAdminMessage, button).catch(error => alert(error.message)));
    });
    document.querySelectorAll('#chat-panel [data-toggle-group-details]').forEach(button => {
      button.addEventListener('click', () => {
        state.expandedGroupId = button.dataset.toggleGroupDetails;
        switchAdminTab('groups');
        renderGroupList();
      });
    });
  }

  function renderChatSidebar() {
    const sidebar = $('chat-sidebar');
    const log = $('chat-sidebar-log');
    const reply = $('chat-sidebar-reply');
    if (!sidebar || !log || !reply) return;
    const students = sortedGroups();
    sidebar.hidden = !state.selectedRebus || !students.length;
    if (sidebar.hidden) {
      log.innerHTML = '';
      reply.innerHTML = '';
      return;
    }
    if (!state.activeChatStudentId || !students.some(student => student.id === state.activeChatStudentId)) {
      state.activeChatStudentId = students[0].id;
    }
    const studentById = new Map(students.map(student => [student.id, student]));
    const recent = [...state.groupMessages]
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
      .slice(-10);
    const latestId = recent[recent.length - 1]?.id || '';
    log.innerHTML = recent.length
      ? recent.map(message => {
        const student = studentById.get(message.student_id);
        const sender = message.sender_type === 'admin'
          ? (message.sender_label || 'Lærer')
          : groupDisplayName(student || {});
        return `
          <button class="sidebar-message ${message.id === latestId ? 'latest' : ''}" type="button" data-sidebar-message="${escapeHtml(message.student_id)}">
            <span>${escapeHtml(groupDisplayName(student || {}))} · ${formatClock(message.created_at)}</span>
            <strong>${escapeHtml(sender)}</strong>
            <p>${escapeHtml(message.body)}</p>
          </button>
        `;
      }).join('')
      : '<p class="muted">Ingen meldinger ennå.</p>';

    const activeStudent = studentById.get(state.activeChatStudentId) || students[0];
    reply.innerHTML = `
      <label><span>Svar til ${escapeHtml(groupDisplayName(activeStudent))}</span><input data-sidebar-message-input="${escapeHtml(activeStudent.id)}" value="${escapeHtml(state.adminMessageDrafts.get(activeStudent.id) || '')}" placeholder="Skriv svar"></label>
      <button class="compact" type="button" data-send-admin-message="${escapeHtml(activeStudent.id)}">Send svar</button>
    `;

    document.querySelectorAll('#chat-sidebar [data-sidebar-message]').forEach(button => {
      button.addEventListener('click', () => {
        state.activeChatStudentId = button.dataset.sidebarMessage;
        renderChatSidebar();
        setTimeout(() => document.querySelector('#chat-sidebar [data-sidebar-message-input]')?.focus(), 0);
      });
    });
    document.querySelectorAll('#chat-sidebar [data-sidebar-message-input]').forEach(input => {
      input.addEventListener('input', () => {
        state.adminMessageDrafts.set(input.dataset.sidebarMessageInput, input.value);
      });
    });
    document.querySelectorAll('#chat-sidebar [data-send-admin-message]').forEach(button => {
      button.addEventListener('click', () => sendAdminMessage(button.dataset.sendAdminMessage, button).catch(error => alert(error.message)));
    });
  }

  async function copyGroupLogin(studentId) {
    const student = state.selectedRebus?.students?.find(item => item.id === studentId);
    if (!student) return;
    const input = document.querySelector(`[data-group-password="${cssEscape(studentId)}"]`);
    const password = groupPassword(student) || input?.value || '';
    const text = `${groupDisplayName(student)}\nBrukernavn: ${student.username || ''}\nKode: ${password}`;
    await navigator.clipboard.writeText(text);
    alert('Innlogging kopiert.');
  }

  function exportGroups() {
    const groups = sortedGroups();
    if (!groups.length) return alert('Ingen grupper å eksportere.');
    const rows = [
      ['Gruppe', 'Brukernavn', 'Kode'],
      ...groups.map(group => [groupDisplayName(group), group.username || '', groupPassword(group)])
    ];
    const csv = rows.map(row => row.map(csvCell).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${slugify(state.selectedRebus?.title || 'rebus')}-grupper.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(link.href);
  }

  function printGroups() {
    const groups = sortedGroups();
    if (!groups.length) return alert('Ingen grupper å printe.');
    const title = state.selectedRebus?.title || 'Rebus';
    const rows = groups.map(group => `
      <tr>
        <td>${escapeHtml(groupDisplayName(group))}</td>
        <td>${escapeHtml(group.username || '')}</td>
        <td>${escapeHtml(groupPassword(group))}</td>
      </tr>
    `).join('');
    const printWindow = window.open('', '_blank', 'width=900,height=700');
    if (!printWindow) return alert('Nettleseren blokkerte utskriftsvinduet.');
    printWindow.document.write(`
      <!doctype html>
      <html lang="no">
      <head>
        <meta charset="utf-8">
        <title>${escapeHtml(title)} - grupper</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 32px; color: #172033; }
          h1 { margin: 0 0 20px; }
          table { width: 100%; border-collapse: collapse; }
          th, td { border: 1px solid #cfd8e3; padding: 10px; text-align: left; font-size: 16px; }
          th { background: #eef3f8; }
          td:last-child { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 700; }
        </style>
      </head>
      <body>
        <h1>${escapeHtml(title)} - grupper</h1>
        <table>
          <thead><tr><th>Gruppe</th><th>Brukernavn</th><th>Kode</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </body>
      </html>
    `);
    printWindow.document.close();
    printWindow.focus();
    printWindow.print();
  }

  function sortedGroups() {
    return [...(state.selectedRebus?.students || [])].sort((a, b) => groupDisplayName(a).localeCompare(groupDisplayName(b), 'no', { numeric: true }));
  }

  function groupDisplayName(student) {
    return student.teamName || student.team_name || student.displayName || student.display_name || student.username || 'Gruppe uten navn';
  }

  function groupPassword(student) {
    return student.password || visiblePassword(student.password_hash) || '';
  }

  function visiblePassword(passwordHash) {
    const value = String(passwordHash || '');
    return value.startsWith('plain:') ? value.slice(6) : '';
  }

  function csvCell(value) {
    return `"${String(value ?? '').replaceAll('"', '""')}"`;
  }

  function renderTasksGroupedByStop(rebus) {
    const stops = rebus.stops || [];
    const stopById = new Map(stops.map(stop => [stop.id, stop]));
    const groups = stops.map(stop => ({
      stop,
      tasks: rebus.tasks.filter(task => task.stop_id === stop.id)
    }));
    const looseTasks = rebus.tasks.filter(task => !task.stop_id || !stopById.has(task.stop_id));
    if (looseTasks.length) groups.push({ stop: null, tasks: looseTasks });

    return groups
      .filter(group => group.tasks.length)
      .map(group => `
        <section class="task-group">
          <h3>${group.stop ? escapeHtml(group.stop.title) : 'Uten stopp'}</h3>
          ${group.stop ? `<p class="muted">${escapeHtml(group.stop.location_label || '')} ${group.stop.latitude ? `${group.stop.latitude}, ${group.stop.longitude}` : ''}</p>` : ''}
          ${group.tasks.map(renderTaskCard).join('')}
        </section>
      `).join('');
  }

  function renderTaskCard(task) {
    const orderedTasks = state.selectedRebus.tasks;
    const index = orderedTasks.findIndex(item => item.id === task.id);
    const badge = index === 0 ? 'Start' : index === orderedTasks.length - 1 ? 'Mål' : `Oppgave ${index + 1}`;
    return `
      <article class="task-card">
        <div class="task-card-header">
          <strong>${badge}: ${escapeHtml(task.title)}</strong>
          <span class="toolbar">
            <button class="ghost compact" type="button" data-move-task="${escapeHtml(task.id)}" data-direction="up" ${index === 0 ? 'disabled' : ''}>Opp</button>
            <button class="ghost compact" type="button" data-move-task="${escapeHtml(task.id)}" data-direction="down" ${index === orderedTasks.length - 1 ? 'disabled' : ''}>Ned</button>
            <button class="ghost compact" type="button" data-preview-task="${escapeHtml(task.id)}">Se som elev</button>
            <button class="ghost compact" type="button" data-edit-task="${escapeHtml(task.id)}">Rediger</button>
          </span>
        </div>
        <p>${escapeHtml(task.prompt || task.description || 'Ingen oppgavetekst.')}</p>
        <small>${escapeHtml(adminTaskTypeLabel(task.type))} · ${task.points} poeng · ${task.location ? `${task.location.lat}, ${task.location.lng}` : 'Ingen egen lokasjon'}</small>
        ${task.options?.length ? `<p><strong>Alternativer:</strong> ${task.options.map(option => `${option.is_correct ? '✓ ' : ''}${escapeHtml(option.label)}`).join(' · ')}</p>` : ''}
        ${task.config?.numberRules ? `<p><strong>Tall:</strong> Riktig ${escapeHtml(task.config.numberRules.correctValue)}${task.config.numberRules.useTolerance ? ` · ${task.config.numberRules.bands.map(band => `±${band.maxDeviation}: ${band.points}p`).join(' · ')}` : ''}</p>` : ''}
        ${task.assets?.length ? `<p><strong>Media:</strong> ${task.assets.map(asset => `<a href="${escapeHtml(asset.url || '#')}" target="_blank" rel="noreferrer">${escapeHtml(asset.title || asset.type)}</a>`).join(' · ')}</p>` : ''}
        ${task.hints?.length ? `<p><strong>Hint:</strong> ${task.hints.map(hint => escapeHtml(hint.body)).join(' · ')}</p>` : ''}
      </article>
    `;
  }

  function bindTaskListActions() {
    document.querySelectorAll('[data-edit-task]').forEach(button => {
      button.addEventListener('click', () => openTaskEditor(button.dataset.editTask));
    });
    document.querySelectorAll('[data-preview-task]').forEach(button => {
      button.addEventListener('click', () => openStudentPreview(button.dataset.previewTask));
    });
    document.querySelectorAll('[data-move-task]').forEach(button => {
      button.addEventListener('click', () => moveTask(button.dataset.moveTask, button.dataset.direction).catch(error => alert(error.message)));
    });
  }

  function openStudentPreview(taskId) {
    if (!state.selectedRebus || !taskId) return;
    const url = `../student/?previewTask=${encodeURIComponent(taskId)}&rebusId=${encodeURIComponent(state.selectedRebus.id)}`;
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  function renderStopSelect() {
    const select = $('task-stop-select');
    const stops = state.selectedRebus?.stops || [];
    select.innerHTML = '<option value="">Ingen stopp valgt</option>' + stops.map(stop => `<option value="${escapeHtml(stop.id)}">${escapeHtml(stop.title)}</option>`).join('');
    if (state.selectedStopId && stops.some(stop => stop.id === state.selectedStopId)) {
      select.value = state.selectedStopId;
    } else {
      state.selectedStopId = '';
      select.value = '';
    }
  }

  async function createRebus() {
    if (state.mode === 'supabase') {
      if (!state.selectedOrganization) return alert('Opprett eller velg en organisasjon først.');
      const { error } = await state.supabase.from('rebuses').insert({
        organization_id: state.selectedOrganization.id,
        title: $('rebus-title').value.trim() || 'Ny rebus',
        description: $('rebus-description').value.trim(),
        rebus_code: suggestedRebusCode($('rebus-title').value.trim() || 'Ny rebus'),
        created_by: state.user.id
      });
      if (error) throw error;
    } else {
      await localApi('/api/admin/rebuses', {
        method: 'POST',
        body: JSON.stringify({
          title: $('rebus-title').value.trim(),
          description: $('rebus-description').value.trim()
        })
      });
    }
    $('rebus-title').value = '';
    $('rebus-description').value = '';
    await loadRebuses();
  }

  async function updateRebus() {
    if (!state.selectedRebus) return alert('Velg en rebus først.');
    const title = $('edit-rebus-title').value.trim() || 'Ny rebus';
    const description = $('edit-rebus-description').value.trim();
    const rebusCode = normalizeRebusCode($('edit-rebus-code').value || suggestedRebusCode(title));
    const status = $('edit-rebus-status').value;
    const showLiveScore = $('edit-rebus-show-score').checked;

    if (state.mode === 'supabase') {
      const { error } = await state.supabase
        .from('rebuses')
        .update({ title, description, rebus_code: rebusCode, status, show_live_score: showLiveScore })
        .eq('id', state.selectedRebus.id);
      if (error) throw error;
    } else {
      await localApi(`/api/admin/rebuses/${state.selectedRebus.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ title, description, rebusCode, status, showLiveScore })
      });
    }

    await selectRebus(state.selectedRebus.id);
    await loadRebuses();
  }

  async function deleteRebus() {
    if (!state.selectedRebus) return alert('Velg en rebus først.');
    const title = state.selectedRebus.title;
    const confirmed = confirm(`Slette "${title}"? Dette fjerner rebusen, oppgaver, grupper og progresjon.`);
    if (!confirmed) return;

    if (state.mode === 'supabase') {
      const { error } = await state.supabase
        .from('rebuses')
        .delete()
        .eq('id', state.selectedRebus.id);
      if (error) throw error;
    } else {
      await localApi(`/api/admin/rebuses/${state.selectedRebus.id}`, {
        method: 'DELETE'
      });
    }

    state.selectedRebus = null;
    state.selectedStopId = '';
    renderEmptyRebus();
    await loadRebuses();
    await loadLive();
  }

  async function createTask() {
    if (!state.selectedRebus) return alert('Velg en rebus først.');
    const lat = parseCoordinate($('task-lat').value);
    const lng = parseCoordinate($('task-lng').value);
    const location = Number.isFinite(lat) && Number.isFinite(lng)
      ? { lat, lng, label: $('task-location-label').value.trim() || $('task-title').value.trim() }
      : null;
    const nextOrder = state.editingTaskId
      ? (state.selectedRebus.tasks.find(task => task.id === state.editingTaskId)?.sort_order || state.selectedRebus.tasks.find(task => task.id === state.editingTaskId)?.order || 1)
      : (state.selectedRebus.tasks?.length || 0) + 1;

    if (state.mode === 'supabase') {
      const payload = {
        rebus_id: state.selectedRebus.id,
        title: $('task-title').value.trim() || 'Ny oppgave',
        type: $('task-type').value,
        prompt: $('task-prompt').value.trim(),
        answer: $('task-answer').value.trim() || null,
        stop_id: state.selectedStopId || null,
        points: Number($('task-points').value || 0),
        sort_order: nextOrder,
        max_attempts: $('task-max-attempts').value ? Number($('task-max-attempts').value) : null,
        geofence_radius_meters: Number($('task-radius').value || 30),
        location_label: location?.label || null,
        latitude: location?.lat || null,
        longitude: location?.lng || null,
        config: {
          answerMode: $('task-type').value,
          createdInBuilder: true,
          hasTeacherMedia: state.assetRows.length > 0,
          presentation: buildPresentationConfig(),
          ...(buildFindDestinationConfig() ? { findDestination: buildFindDestinationConfig() } : {}),
          ...(buildMovementConfig() ? { movement: buildMovementConfig() } : {}),
          ...(buildNumberRules() ? { numberRules: buildNumberRules() } : {})
        }
      };
      if (state.editingTaskId) {
        const { data: updatedTask, error } = await state.supabase
          .from('tasks')
          .update(payload)
          .eq('id', state.editingTaskId)
          .select()
          .single();
        if (error) throw error;
        await replaceRichTaskChildren(updatedTask.id);
      } else {
        const { data: insertedTask, error } = await state.supabase.from('tasks').insert(payload).select().single();
      if (error) throw error;
      await createRichTaskChildren(insertedTask.id);
      }
    } else {
      await localApi(`/api/admin/rebuses/${state.selectedRebus.id}/tasks`, {
        method: 'POST',
        body: JSON.stringify({
          title: $('task-title').value.trim(),
          type: $('task-type').value,
          prompt: $('task-prompt').value.trim(),
          answer: $('task-answer').value.trim(),
          points: Number($('task-points').value || 0),
          maxAttempts: $('task-max-attempts').value ? Number($('task-max-attempts').value) : null,
          geofenceRadiusMeters: Number($('task-radius').value || 30),
          location
        })
      });
    }
    clearTaskForm();
    closeTaskEditor();
    await selectRebus(state.selectedRebus.id);
    await loadRebuses();
  }

  function clearTaskForm() {
    $('task-title').value = '';
    $('task-prompt').value = '';
    $('task-answer').value = '';
    $('task-max-attempts').value = '';
    resetTaskBuilder();
    updateTaskTypeUi();
  }

  function openTaskEditor(taskId = null) {
    state.editingTaskId = taskId;
    $('task-editor').hidden = false;
    $('task-editor-title').textContent = taskId ? 'Rediger oppgave' : 'Ny oppgave';
    $('create-task-button').textContent = taskId ? 'Lagre endringer' : 'Lagre oppgave';
    if (!taskId) {
      clearTaskForm();
      focusTaskEditor();
      return;
    }
    const task = state.selectedRebus.tasks.find(item => item.id === taskId);
    if (!task) return;
    fillTaskForm(task);
    focusTaskEditor();
  }

  function focusTaskEditor() {
    requestAnimationFrame(() => {
      $('task-editor').scrollIntoView({ behavior: 'smooth', block: 'start' });
      $('task-title')?.focus({ preventScroll: true });
    });
  }

  function closeTaskEditor() {
    state.editingTaskId = null;
    $('task-editor').hidden = true;
  }

  function fillTaskForm(task) {
    const lat = task.latitude ?? task.location?.lat ?? task.stop?.location?.lat ?? '';
    const lng = task.longitude ?? task.location?.lng ?? task.stop?.location?.lng ?? '';
    const label = task.location_label || task.location?.label || task.stop?.location?.label || '';
    $('task-title').value = task.title || '';
    $('task-type').value = task.type || 'text';
    $('task-points').value = task.points || 0;
    $('task-max-attempts').value = task.max_attempts || '';
    $('task-lat').value = lat;
    $('task-lng').value = lng;
    $('task-location-label').value = label;
    $('task-radius').value = task.geofence_radius_meters || 30;
    $('task-prompt').value = task.prompt || '';
    $('task-answer').value = task.answer || '';
    $('find-show-distance').checked = task.config?.findDestination?.showDistance !== false;
    $('presentation-title').value = task.config?.presentation?.title || '';
    $('presentation-intro').value = task.config?.presentation?.intro || '';
    $('presentation-show-distance').checked = task.config?.presentation?.showDistance !== false;
    $('target-speed-kmh').value = task.config?.movement?.targetSpeedKmh || 3;
    state.selectedStopId = task.stop_id || '';
    renderStopSelect();
    state.optionRows = task.options?.length ? task.options.map(option => ({
      id: crypto.randomUUID(),
      label: option.label,
      isCorrect: option.is_correct
    })) : state.optionRows;
    state.assetRows = task.assets?.map(asset => ({
      id: crypto.randomUUID(),
      type: asset.type,
      title: asset.title || '',
      url: asset.url || '',
      fileName: ''
    })) || [];
    state.hintRows = task.hints?.map(hint => ({
      id: crypto.randomUUID(),
      body: hint.body
    })) || [];
    if (task.config?.numberRules) {
      $('number-correct-value').value = task.config.numberRules.correctValue;
      $('number-use-tolerance').checked = Boolean(task.config.numberRules.useTolerance);
      state.numberBands = task.config.numberRules.bands.map(band => ({
        id: crypto.randomUUID(),
        maxDeviation: band.maxDeviation,
        points: band.points
      }));
    }
    renderOptionRows();
    renderAssetRows();
    renderHintRows();
    renderNumberBands();
    updateTaskTypeUi();
    const parsedLat = parseCoordinate(lat);
    const parsedLng = parseCoordinate(lng);
    if (Number.isFinite(parsedLat) && Number.isFinite(parsedLng)) {
      focusMapOnLocation(parsedLat, parsedLng);
    }
  }

  async function replaceRichTaskChildren(taskId) {
    await Promise.all([
      state.supabase.from('task_options').delete().eq('task_id', taskId),
      state.supabase.from('task_assets').delete().eq('task_id', taskId),
      state.supabase.from('task_hints').delete().eq('task_id', taskId)
    ]);
    await createRichTaskChildren(taskId);
  }

  async function moveTask(taskId, direction) {
    const tasks = [...state.selectedRebus.tasks].sort((a, b) => a.sort_order - b.sort_order);
    const index = tasks.findIndex(task => task.id === taskId);
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (index < 0 || targetIndex < 0 || targetIndex >= tasks.length) return;
    const current = tasks[index];
    const target = tasks[targetIndex];
    const { error: firstError } = await state.supabase.from('tasks').update({ sort_order: target.sort_order }).eq('id', current.id);
    if (firstError) throw firstError;
    const { error: secondError } = await state.supabase.from('tasks').update({ sort_order: current.sort_order }).eq('id', target.id);
    if (secondError) throw secondError;
    await selectRebus(state.selectedRebus.id);
  }

  async function createRichTaskChildren(taskId) {
    await uploadPendingTaskAssets(taskId);
    const options = collectOptions(taskId);
    const assets = collectAssets(taskId);
    const hints = collectHints(taskId);

    if (options.length) {
      const { error } = await state.supabase.from('task_options').insert(options);
      if (error) throw error;
    }
    if (assets.length) {
      const { error } = await state.supabase.from('task_assets').insert(assets);
      if (error) throw error;
    }
    if (hints.length) {
      const { error } = await state.supabase.from('task_hints').insert(hints);
      if (error) throw error;
    }
  }

  function resetTaskBuilder() {
    state.optionRows = [
      { id: crypto.randomUUID(), label: '', isCorrect: true },
      { id: crypto.randomUUID(), label: '', isCorrect: false },
      { id: crypto.randomUUID(), label: '', isCorrect: false }
    ];
    state.assetRows = [];
    state.hintRows = [];
    $('find-show-distance').checked = true;
    $('presentation-title').value = '';
    $('presentation-intro').value = '';
    $('presentation-show-distance').checked = true;
    $('target-speed-kmh').value = 3;
    state.numberBands = [
      { id: crypto.randomUUID(), maxDeviation: 0, points: Number($('task-points').value || 5) },
      { id: crypto.randomUUID(), maxDeviation: 1, points: Math.max(0, Number($('task-points').value || 5) - 1) },
      { id: crypto.randomUUID(), maxDeviation: 2, points: Math.max(0, Number($('task-points').value || 5) - 2) }
    ];
    renderOptionRows();
    renderAssetRows();
    renderHintRows();
    renderNumberBands();
  }

  function updateTaskTypeUi() {
    const type = $('task-type').value;
    const usesOptions = type === 'multiple_choice' || type === 'multi_select';
    $('options-builder').hidden = !usesOptions;
    $('number-builder').hidden = type !== 'number';
    $('find-destination-builder').hidden = type !== 'find_destination';
    $('movement-builder').hidden = !['speed_photo', 'pace_match'].includes(type);
    $('target-speed-label').hidden = type !== 'pace_match';
    $('movement-help').textContent = type === 'speed_photo'
      ? 'Elevene ser målpunktet, kommer seg dit raskest mulig og dokumenterer at gruppa er samlet med bilde.'
      : type === 'pace_match'
        ? 'Elevene går til målpunktet. GPS-punktene underveis brukes til å beregne snittfart og poeng nær målfarten.'
        : '';
    $('task-answer').closest('label').hidden = usesOptions || ['number', 'find_destination', 'speed_photo', 'pace_match', 'photo', 'video', 'audio', 'teacher_approved'].includes(type);
    if (usesOptions && state.optionRows.length < 3) {
      while (state.optionRows.length < 3) addOptionRow(false);
      renderOptionRows();
    }
  }

  function addOptionRow(shouldRender = true) {
    state.optionRows.push({ id: crypto.randomUUID(), label: '', isCorrect: false });
    if (shouldRender) renderOptionRows();
  }

  function addAssetRow() {
    state.assetRows.push({ id: crypto.randomUUID(), type: 'image', title: '', url: '', fileName: '', file: null, uploadStatus: '' });
    renderAssetRows();
  }

  function addHintRow() {
    state.hintRows.push({ id: crypto.randomUUID(), body: '' });
    renderHintRows();
  }

  function addNumberBand() {
    const last = state.numberBands[state.numberBands.length - 1];
    state.numberBands.push({
      id: crypto.randomUUID(),
      maxDeviation: last ? Number(last.maxDeviation) + 1 : 0,
      points: last ? Math.max(0, Number(last.points) - 1) : 0
    });
    renderNumberBands();
  }

  function renderOptionRows() {
    $('option-rows').innerHTML = state.optionRows.map((row, index) => `
      <div class="builder-row" data-option-id="${row.id}">
        <label class="check-label"><input type="checkbox" data-option-correct ${row.isCorrect ? 'checked' : ''}> Riktig</label>
        <label><span>Alternativ ${index + 1}</span><input data-option-label value="${escapeHtml(row.label)}" placeholder="Skriv svaralternativ"></label>
        <button class="ghost" type="button" data-remove-option ${state.optionRows.length <= 2 ? 'disabled' : ''}>Fjern</button>
      </div>
    `).join('');
    bindOptionRows();
  }

  function renderAssetRows() {
    $('asset-rows').innerHTML = state.assetRows.length ? state.assetRows.map((row, index) => `
      <div class="builder-row media" data-asset-id="${row.id}">
        <label><span>Type</span><select data-asset-type><option value="image" ${row.type === 'image' ? 'selected' : ''}>Bilde</option><option value="audio" ${row.type === 'audio' ? 'selected' : ''}>Lyd</option><option value="video" ${row.type === 'video' ? 'selected' : ''}>Video</option><option value="link" ${row.type === 'link' ? 'selected' : ''}>Lenke</option><option value="document" ${row.type === 'document' ? 'selected' : ''}>Dokument</option></select></label>
        <label><span>Tittel</span><input data-asset-title value="${escapeHtml(row.title)}" placeholder="F.eks. Lydklipp"></label>
        <label><span>URL</span><input data-asset-url value="${escapeHtml(row.url)}" placeholder="https://..."></label>
        <button class="ghost" type="button" data-remove-asset>Fjern</button>
        <label class="file-note"><span>Fil fra maskinen</span><input data-asset-file type="file" accept="image/*,audio/*,video/*,.pdf,.doc,.docx,.ppt,.pptx"></label>
        ${row.fileName ? `<p class="muted">Valgt fil: ${escapeHtml(row.fileName)}${row.uploadStatus ? ` · ${escapeHtml(row.uploadStatus)}` : ' · lastes opp når oppgaven lagres'}</p>` : ''}
      </div>
    `).join('') : '<p class="muted">Ingen media lagt til. Oppgaven kan fortsatt ha bare tekst.</p>';
    bindAssetRows();
  }

  function renderHintRows() {
    $('hint-rows').innerHTML = state.hintRows.length ? state.hintRows.map((row, index) => `
      <div class="builder-row hint" data-hint-id="${row.id}">
        <label><span>Hint ${index + 1}</span><input data-hint-body value="${escapeHtml(row.body)}" placeholder="Skriv et hint"></label>
        <button class="ghost" type="button" data-remove-hint>Fjern</button>
      </div>
    `).join('') : '<p class="muted">Ingen hint lagt til.</p>';
    bindHintRows();
  }

  function renderNumberBands() {
    $('number-band-rows').innerHTML = state.numberBands.map((row, index) => `
      <div class="builder-row number-band" data-number-band-id="${row.id}">
        <label><span>Avvik maks</span><input data-band-deviation type="number" min="0" step="any" value="${escapeHtml(row.maxDeviation)}"></label>
        <label><span>Poeng</span><input data-band-points type="number" min="0" step="any" value="${escapeHtml(row.points)}"></label>
        <button class="ghost" type="button" data-remove-band ${state.numberBands.length <= 1 ? 'disabled' : ''}>Fjern</button>
        ${index === 0 ? '<p class="file-note">Avvik 0 betyr helt riktig. Avvik 1 betyr ett unna, for eksempel 23 eller 25 når riktig svar er 24.</p>' : ''}
      </div>
    `).join('');
    bindNumberBands();
  }

  function bindOptionRows() {
    document.querySelectorAll('[data-option-id]').forEach(element => {
      const row = state.optionRows.find(item => item.id === element.dataset.optionId);
      element.querySelector('[data-option-label]').addEventListener('input', event => {
        row.label = event.target.value;
      });
      element.querySelector('[data-option-correct]').addEventListener('change', event => {
        row.isCorrect = event.target.checked;
        if ($('task-type').value === 'multiple_choice' && row.isCorrect) {
          state.optionRows.forEach(item => {
            if (item.id !== row.id) item.isCorrect = false;
          });
          renderOptionRows();
        }
      });
      element.querySelector('[data-remove-option]').addEventListener('click', () => {
        state.optionRows = state.optionRows.filter(item => item.id !== row.id);
        renderOptionRows();
      });
    });
  }

  function bindAssetRows() {
    document.querySelectorAll('[data-asset-id]').forEach(element => {
      const row = state.assetRows.find(item => item.id === element.dataset.assetId);
      element.querySelector('[data-asset-type]').addEventListener('change', event => {
        row.type = event.target.value;
      });
      element.querySelector('[data-asset-title]').addEventListener('input', event => {
        row.title = event.target.value;
      });
      element.querySelector('[data-asset-url]').addEventListener('input', event => {
        row.url = event.target.value;
      });
      element.querySelector('[data-asset-file]').addEventListener('change', event => {
        const file = event.target.files && event.target.files[0];
        row.fileName = file ? file.name : '';
        row.file = file || null;
        row.uploadStatus = '';
        if (file && !row.title) row.title = file.name;
        if (file) {
          row.url = '';
          if (file.type.startsWith('audio/')) row.type = 'audio';
          else if (file.type.startsWith('video/')) row.type = 'video';
          else if (file.type.startsWith('image/')) row.type = 'image';
          else row.type = 'document';
        }
        renderAssetRows();
      });
      element.querySelector('[data-remove-asset]').addEventListener('click', () => {
        state.assetRows = state.assetRows.filter(item => item.id !== row.id);
        renderAssetRows();
      });
    });
  }

  function bindHintRows() {
    document.querySelectorAll('[data-hint-id]').forEach(element => {
      const row = state.hintRows.find(item => item.id === element.dataset.hintId);
      element.querySelector('[data-hint-body]').addEventListener('input', event => {
        row.body = event.target.value;
      });
      element.querySelector('[data-remove-hint]').addEventListener('click', () => {
        state.hintRows = state.hintRows.filter(item => item.id !== row.id);
        renderHintRows();
      });
    });
  }

  function bindNumberBands() {
    document.querySelectorAll('[data-number-band-id]').forEach(element => {
      const row = state.numberBands.find(item => item.id === element.dataset.numberBandId);
      element.querySelector('[data-band-deviation]').addEventListener('input', event => {
        row.maxDeviation = event.target.value;
      });
      element.querySelector('[data-band-points]').addEventListener('input', event => {
        row.points = event.target.value;
      });
      element.querySelector('[data-remove-band]').addEventListener('click', () => {
        state.numberBands = state.numberBands.filter(item => item.id !== row.id);
        renderNumberBands();
      });
    });
  }

  function collectOptions(taskId) {
    const rows = state.optionRows
      .map(row => ({ ...row, label: row.label.trim() }))
      .filter(row => row.label);
    if (!['multiple_choice', 'multi_select'].includes($('task-type').value)) return [];
    return rows.map((row, index) => ({
      task_id: taskId,
      label: row.label,
      is_correct: row.isCorrect,
      sort_order: index + 1
    }));
  }

  function collectAssets(taskId) {
    return state.assetRows
      .map(row => ({
        ...row,
        title: row.title.trim(),
        url: row.url.trim()
      }))
      .filter(row => row.url || row.fileName)
      .map((row, index) => ({
        task_id: taskId,
        type: row.type,
        title: row.title || row.fileName || row.type,
        url: row.url || null,
        storage_bucket: row.storageBucket || null,
        storage_path: row.storagePath || null,
        sort_order: index + 1
      }));
  }

  async function uploadPendingTaskAssets(taskId) {
    if (state.mode !== 'supabase') return;
    for (const row of state.assetRows) {
      if (!row.file) continue;
      row.uploadStatus = 'laster opp...';
      renderAssetRows();
      const storagePath = [
        state.selectedOrganization?.id || 'organization',
        state.selectedRebus?.id || 'rebus',
        taskId,
        `${Date.now()}-${safeStorageName(row.file.name)}`
      ].join('/');
      const { error } = await state.supabase.storage
        .from('task-assets')
        .upload(storagePath, row.file, {
          contentType: row.file.type || 'application/octet-stream',
          upsert: false
        });
      if (error) throw error;
      const { data } = state.supabase.storage.from('task-assets').getPublicUrl(storagePath);
      row.url = data.publicUrl;
      row.storageBucket = 'task-assets';
      row.storagePath = storagePath;
      row.uploadStatus = 'opplastet';
      row.file = null;
    }
  }

  function safeStorageName(name) {
    return String(name || 'media')
      .normalize('NFKD')
      .replace(/[^\w.\-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 90) || 'media';
  }

  function collectHints(taskId) {
    return state.hintRows
      .map(row => row.body.trim())
      .filter(Boolean)
      .map((body, index) => ({
        task_id: taskId,
        body,
        sort_order: index + 1
      }));
  }

  function buildNumberRules() {
    if ($('task-type').value !== 'number') return null;
    const correctValue = Number($('number-correct-value').value);
    if (!Number.isFinite(correctValue)) return null;
    const useTolerance = $('number-use-tolerance').checked;
    const bands = state.numberBands
      .map(row => ({
        maxDeviation: Number(row.maxDeviation),
        points: Number(row.points)
      }))
      .filter(row => Number.isFinite(row.maxDeviation) && Number.isFinite(row.points))
      .sort((a, b) => a.maxDeviation - b.maxDeviation);
    return {
      correctValue,
      useTolerance,
      bands: useTolerance ? bands : [{ maxDeviation: 0, points: Number($('task-points').value || 0) }]
    };
  }

  function buildFindDestinationConfig() {
    if ($('task-type').value !== 'find_destination') return null;
    return {
      showDistance: $('find-show-distance').checked
    };
  }

  function buildPresentationConfig() {
    return {
      title: $('presentation-title').value.trim(),
      intro: $('presentation-intro').value.trim(),
      showDistance: $('presentation-show-distance').checked
    };
  }

  function buildMovementConfig() {
    const type = $('task-type').value;
    if (!['speed_photo', 'pace_match'].includes(type)) return null;
    return {
      targetSpeedKmh: Number($('target-speed-kmh').value || 3)
    };
  }

  function adminTaskTypeLabel(type) {
    const labels = {
      text: 'Tekstsvar',
      find_destination: 'Finn frem!',
      speed_photo: 'Raskest til posten + bilde',
      pace_match: 'Jevn fart',
      number: 'Tallsvar',
      multiple_choice: 'Multiple choice',
      multi_select: 'Flere riktige valg',
      photo: 'Bildeinnlevering',
      video: 'Videoinnlevering',
      audio: 'Lydoppgave',
      teacher_approved: 'Lærergodkjent',
      qr_code: 'Kode/QR'
    };
    return labels[type] || type || 'Oppgave';
  }

  async function createStudent() {
    if (!state.selectedRebus) return alert('Velg en rebus først.');
    const groupName = $('group-name').value.trim();
    const username = ($('group-username').value.trim() || slugify(groupName)).toLowerCase();
    const password = $('group-password').value || generateAccessCode();
    if (!groupName) return alert('Skriv inn gruppenavn først.');
    if (!username) return alert('Skriv inn brukernavn først.');
    if (state.mode === 'supabase') {
      const { error } = await state.supabase.from('students').insert({
        rebus_id: state.selectedRebus.id,
        display_name: groupName,
        username,
        password_hash: `plain:${password}`,
        team_name: groupName
      });
      if (error) throw error;
    } else {
      await localApi(`/api/admin/rebuses/${state.selectedRebus.id}/students`, {
        method: 'POST',
        body: JSON.stringify({
          displayName: groupName,
          username,
          password,
          teamName: groupName
        })
      });
    }
    $('group-name').value = '';
    $('group-username').value = '';
    $('group-password').value = generateAccessCode();
    state.lastSuggestedGroupName = '';
    state.lastSuggestedGroupUsername = '';
    await selectRebus(state.selectedRebus.id);
    await loadRebuses();
  }

  async function updateGroupPassword(studentId) {
    if (!state.selectedRebus) return alert('Velg en rebus først.');
    const input = document.querySelector(`[data-group-password="${cssEscape(studentId)}"]`);
    const password = input?.value || '';
    if (!password) return alert('Skriv inn eller generer en ny kode først.');

    if (state.mode === 'supabase') {
      const { error } = await state.supabase
        .from('students')
        .update({ password_hash: `plain:${password}` })
        .eq('id', studentId)
        .eq('rebus_id', state.selectedRebus.id);
      if (error) throw error;
    } else {
      await localApi(`/api/admin/rebuses/${state.selectedRebus.id}/students/${studentId}/password`, {
        method: 'PATCH',
        body: JSON.stringify({ password })
      });
    }

    input.value = '';
    const student = state.selectedRebus.students.find(item => item.id === studentId);
    if (student) {
      student.password = password;
      student.password_hash = `plain:${password}`;
    }
    renderGroupList();
    alert('Koden er oppdatert.');
  }

  async function updateGroup(studentId) {
    if (!state.selectedRebus) return alert('Velg en rebus først.');
    const name = document.querySelector(`[data-group-name="${cssEscape(studentId)}"]`)?.value.trim();
    const username = document.querySelector(`[data-group-username="${cssEscape(studentId)}"]`)?.value.trim().toLowerCase();
    if (!name || !username) return alert('Gruppenavn og brukernavn må fylles ut.');

    if (state.mode === 'supabase') {
      const { error } = await state.supabase
        .from('students')
        .update({ display_name: name, team_name: name, username })
        .eq('id', studentId)
        .eq('rebus_id', state.selectedRebus.id);
      if (error) throw error;
    } else {
      await localApi(`/api/admin/rebuses/${state.selectedRebus.id}/students/${studentId}`, {
        method: 'PATCH',
        body: JSON.stringify({ displayName: name, teamName: name, username })
      });
    }

    await selectRebus(state.selectedRebus.id);
  }

  async function deleteGroup(studentId) {
    if (!state.selectedRebus) return alert('Velg en rebus først.');
    const student = state.selectedRebus.students.find(item => item.id === studentId);
    const name = student ? groupDisplayName(student) : 'gruppen';
    if (!confirm(`Slette ${name}? Dette fjerner gruppen og progresjonen deres.`)) return;

    if (state.mode === 'supabase') {
      const { error } = await state.supabase
        .from('students')
        .delete()
        .eq('id', studentId)
        .eq('rebus_id', state.selectedRebus.id);
      if (error) throw error;
    } else {
      await localApi(`/api/admin/rebuses/${state.selectedRebus.id}/students/${studentId}`, {
        method: 'DELETE'
      });
    }

    await selectRebus(state.selectedRebus.id);
    await loadLive();
  }

  async function loadGroupMessages({ notify = true, rerender = true } = {}) {
    if (state.mode !== 'supabase' || !state.selectedRebus) return;
    const { data, error } = await state.supabase
      .from('group_messages')
      .select('*')
      .eq('rebus_id', state.selectedRebus.id)
      .order('created_at', { ascending: true });
    if (error) throw error;
    const messages = data || [];
    const newStudentMessages = messages.filter(message =>
      message.sender_type === 'student' &&
      !message.read_by_admin_at &&
      !state.seenMessageIds.has(message.id)
    );
    state.groupMessages = messages;
    if (notify) {
      newStudentMessages.forEach(message => {
        state.seenMessageIds.add(message.id);
        const student = state.selectedRebus.students?.find(item => item.id === message.student_id);
        showNotification(`Ny melding fra ${student ? groupDisplayName(student) : 'gruppe'}`, message.body);
        playNotificationSound();
      });
    }
    if (notify && newStudentMessages.length) {
      await state.supabase
        .from('group_messages')
        .update({ read_by_admin_at: new Date().toISOString() })
        .in('id', newStudentMessages.map(message => message.id));
      state.groupMessages = state.groupMessages.map(message =>
        newStudentMessages.some(item => item.id === message.id)
          ? { ...message, read_by_admin_at: message.read_by_admin_at || new Date().toISOString() }
          : message
      );
    }
    if (rerender && state.activeAdminTab === 'groups' && !isEditingAdminInput()) renderGroupList();
    if (rerender && state.activeAdminTab === 'chat' && !isEditingAdminInput()) renderChatTab();
    if (rerender && !isEditingAdminInput()) renderChatSidebar();
  }

  function isEditingAdminInput() {
    const active = document.activeElement;
    return Boolean(active && ($('group-list')?.contains(active) || $('chat-panel')?.contains(active) || $('chat-sidebar')?.contains(active)) && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName));
  }

  async function sendAdminMessage(studentId, sourceButton = null) {
    if (state.mode !== 'supabase') return alert('Meldinger krever Supabase-modus.');
    if (!state.selectedRebus) return alert('Velg en rebus først.');
    const sourceRoot = sourceButton?.closest('.message-composer, .chat-sidebar-reply, .group-message-box') || null;
    const input = sourceRoot?.querySelector('input, textarea') ||
      document.querySelector(`[data-sidebar-message-input="${cssEscape(studentId)}"]`) ||
      document.querySelector(`[data-chat-message="${cssEscape(studentId)}"]`) ||
      document.querySelector(`[data-admin-message="${cssEscape(studentId)}"]`);
    const body = input?.value.trim();
    if (!body) return alert('Skriv en melding først.');
    const { error } = await state.supabase.from('group_messages').insert({
      rebus_id: state.selectedRebus.id,
      student_id: studentId,
      sender_type: 'admin',
      sender_admin_id: state.user?.id || null,
      sender_label: `Lærer - ${state.profile?.nickname || suggestedTeacherNick()}`,
      body
    });
    if (error) throw error;
    input.value = '';
    state.adminMessageDrafts.delete(studentId);
    await loadGroupMessages({ notify: false, rerender: false });
    renderChatTab();
    renderChatSidebar();
    renderGroupList();
    showNotification('Melding sendt', 'Gruppa får meldingen som pop-up i elevappen.');
  }

  async function saveGroupRoute(studentId) {
    if (state.mode !== 'supabase') return alert('Løypestyring krever Supabase-modus.');
    if (!state.selectedRebus) return alert('Velg en rebus først.');
    const skippedTaskIds = Array.from(document.querySelectorAll(`[data-route-skip="${cssEscape(studentId)}"]:checked`)).map(input => input.value);
    await saveRouteOverrides(studentId, skippedTaskIds);
    showNotification('Løype lagret', 'Gruppa får oppdatert neste post ved neste oppdatering.');
  }

  async function sendGroupToGoal(studentId) {
    if (!state.selectedRebus) return alert('Velg en rebus først.');
    const tasks = state.selectedRebus.tasks || [];
    if (tasks.length < 2) return alert('Rebusen må ha minst start og mål.');
    if (!confirm('Sende denne gruppa direkte til mål? Alle oppgaver før siste post hoppes over for denne gruppa.')) return;
    await saveRouteOverrides(studentId, tasks.slice(0, -1).map(task => task.id));
    showNotification('Gruppa er sendt til mål', 'Neste synlige post for gruppa er siste oppgave.');
  }

  async function adjustGroupScore(studentId) {
    if (state.mode !== 'supabase') return alert('Straff/belønning krever Supabase-modus.');
    if (!state.selectedRebus) return alert('Velg en rebus først.');
    const points = Number(document.querySelector(`[data-adjust-points="${cssEscape(studentId)}"]`)?.value || 0);
    const reason = document.querySelector(`[data-adjust-reason="${cssEscape(studentId)}"]`)?.value.trim() || '';
    if (!Number.isInteger(points) || points < -5 || points > 5 || points === 0) {
      return alert('Poeng må være et helt tall fra -5 til -1 eller fra 1 til 5.');
    }
    if (!reason) return alert('Skriv en kort begrunnelse.');
    const { error } = await state.supabase.from('group_score_adjustments').insert({
      rebus_id: state.selectedRebus.id,
      student_id: studentId,
      points,
      reason,
      created_by: state.user?.id || null
    });
    if (error) throw error;
    const student = state.selectedRebus.students.find(item => item.id === studentId);
    showScoreNotification(points, reason, student ? groupDisplayName(student) : 'Gruppa');
    await selectRebus(state.selectedRebus.id);
    await loadLive();
  }

  async function openSubmission(sourceButton) {
    if (state.mode !== 'supabase') return alert('Mediaåpning krever Supabase-modus.');
    const storagePath = sourceButton?.dataset.openSubmission || '';
    if (!storagePath) return alert('Fant ikke filstien for innleveringen.');
    const { data, error } = await state.supabase.storage
      .from('submissions')
      .createSignedUrl(storagePath, 60 * 10);
    if (error) throw error;
    showSubmissionPreview({
      url: data.signedUrl,
      contentType: sourceButton?.dataset.submissionType || '',
      title: sourceButton?.dataset.submissionName || 'Innlevering'
    });
  }

  function showSubmissionPreview({ url, contentType, title }) {
    const modal = $('submission-preview-modal');
    const body = $('submission-preview-body');
    const titleElement = $('submission-preview-title');
    if (!modal || !body || !titleElement) {
      window.open(url, '_blank', 'noopener,noreferrer');
      return;
    }
    titleElement.textContent = title || 'Innlevering';
    const type = String(contentType || '').toLowerCase();
    if (type.startsWith('image/')) {
      body.innerHTML = `<img class="submission-preview-media" src="${escapeAttribute(url)}" alt="${escapeAttribute(title || 'Innlevering')}">`;
    } else if (type.startsWith('video/')) {
      body.innerHTML = `<video class="submission-preview-media" src="${escapeAttribute(url)}" controls autoplay></video>`;
    } else if (type.startsWith('audio/')) {
      body.innerHTML = `<audio class="submission-preview-audio" src="${escapeAttribute(url)}" controls autoplay></audio>`;
    } else {
      body.innerHTML = `
        <p class="muted">Denne filtypen kan ikke forhåndsvises sikkert i nettleseren.</p>
        <a class="button-like" href="${escapeAttribute(url)}" target="_blank" rel="noreferrer">Åpne i ny fane</a>
      `;
    }
    modal.hidden = false;
    document.body.classList.add('modal-open');
  }

  function closeSubmissionPreview() {
    const modal = $('submission-preview-modal');
    const body = $('submission-preview-body');
    if (!modal || !body) return;
    modal.hidden = true;
    body.innerHTML = '';
    document.body.classList.remove('modal-open');
  }

  async function saveManualScore(progressId, sourceButton) {
    if (state.mode !== 'supabase') return alert('Manuell poengsetting krever Supabase-modus.');
    if (!state.selectedRebus) return alert('Velg en rebus først.');
    if (!progressId) return alert('Fant ikke progresjonsraden som skal vurderes.');
    const scope = sourceButton?.closest('.submission-card, .manual-score-inline') || document;
    const input = scope.querySelector(`[data-manual-points="${cssEscape(progressId)}"]`) ||
      document.querySelector(`[data-manual-points="${cssEscape(progressId)}"]`);
    const points = Number(input?.value ?? 0);
    if (!Number.isFinite(points) || points < 0) return alert('Poeng må være 0 eller mer.');
    const { error } = await state.supabase
      .from('progress')
      .update({
        points_awarded: points,
        correct: true,
        status: 'approved'
      })
      .eq('id', progressId)
      .eq('rebus_id', state.selectedRebus.id);
    if (error) throw error;
    showNotification('Poeng lagret', `${points} poeng er registrert.`);
    await selectRebus(state.selectedRebus.id);
    await loadLive();
  }

  async function downloadSubmissionsZip() {
    if (state.mode !== 'supabase') return alert('ZIP-nedlasting krever Supabase-modus.');
    if (!state.selectedRebus) return alert('Velg en rebus først.');
    await refreshSelectedRebusForSubmissions();
    const rows = allSubmissionRows();
    if (!rows.length) return alert('Ingen innleveringer å laste ned.');
    const button = $('download-submissions-button');
    const originalText = button?.textContent || 'Last ned ZIP';
    if (button) {
      button.disabled = true;
      button.textContent = 'Pakker ZIP...';
    }
    try {
      await loadScript('https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js');
      const zip = new window.JSZip();
      for (const [index, row] of rows.entries()) {
        const storagePath = row.submission.storage_path || row.submission.storagePath;
        if (!storagePath) continue;
        const { data, error } = await state.supabase.storage.from('submissions').download(storagePath);
        if (error) throw error;
        const groupFolder = slugify(groupDisplayName(row.student)) || 'gruppe';
        zip.file(`${groupFolder}/${submissionFileName(row.submission, row.student, index)}`, data);
      }
      const blob = await zip.generateAsync({ type: 'blob' });
      downloadBlob(blob, `${slugify(state.selectedRebus.title || 'rebus')}-innleveringer.zip`);
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = originalText;
      }
    }
  }

  async function deleteAllSubmissions() {
    if (state.mode !== 'supabase') return alert('Sletting krever Supabase-modus.');
    if (!state.selectedRebus) return alert('Velg en rebus først.');
    await refreshSelectedRebusForSubmissions();
    const rows = allSubmissionRows();
    if (!rows.length) return alert('Ingen innleveringer å slette.');
    const confirmation = prompt(`Dette sletter ${rows.length} innleverte filer for "${state.selectedRebus.title}". Poeng og progresjon beholdes. Skriv SLETT for å bekrefte.`);
    if (confirmation !== 'SLETT') return;
    const paths = rows.map(row => row.submission.storage_path || row.submission.storagePath).filter(Boolean);
    if (paths.length) {
      const { error: storageError } = await state.supabase.storage.from('submissions').remove(paths);
      if (storageError) throw storageError;
    }
    const { error } = await state.supabase
      .from('submissions')
      .delete()
      .eq('rebus_id', state.selectedRebus.id);
    if (error) throw error;
    showNotification('Innleveringer slettet', 'Filene er fjernet fra Supabase Storage. Poeng og progresjon er beholdt.');
    await selectRebus(state.selectedRebus.id);
    await loadLive();
  }

  function downloadBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function showScoreNotification(points, reason, groupName) {
    const positive = Number(points) > 0;
    showNotification(
      `${positive ? 'Belønning' : 'Straff'} til ${groupName}`,
      `${signedNumber(points)} poeng: ${reason}`
    );
  }

  async function saveRouteOverrides(studentId, skippedTaskIds) {
    const { error: deleteError } = await state.supabase
      .from('student_task_overrides')
      .delete()
      .eq('student_id', studentId)
      .eq('rebus_id', state.selectedRebus.id);
    if (deleteError) throw deleteError;

    if (skippedTaskIds.length) {
      const rows = skippedTaskIds.map(taskId => ({
        student_id: studentId,
        task_id: taskId,
        rebus_id: state.selectedRebus.id,
        is_skipped: true
      }));
      const { error: insertError } = await state.supabase.from('student_task_overrides').insert(rows);
      if (insertError) throw insertError;
    }
    await selectRebus(state.selectedRebus.id);
  }

  async function createStopFromCurrentLocation() {
    if (state.mode !== 'supabase') return alert('Stopp krever Supabase-modus.');
    if (!state.selectedRebus) return alert('Velg en rebus først.');
    const lat = parseCoordinate($('task-lat').value);
    const lng = parseCoordinate($('task-lng').value);
    const nextOrder = (state.selectedRebus.stops?.length || 0) + 1;
    const { data, error } = await state.supabase.from('rebus_stops').insert({
      rebus_id: state.selectedRebus.id,
      title: $('stop-title').value.trim() || $('task-location-label').value.trim() || `Stopp ${nextOrder}`,
      sort_order: nextOrder,
      location_label: $('task-location-label').value.trim() || null,
      latitude: Number.isFinite(lat) ? lat : null,
      longitude: Number.isFinite(lng) ? lng : null,
      geofence_radius_meters: Number($('task-radius').value || 30)
    }).select().single();
    if (error) throw error;
    state.selectedStopId = data.id;
    $('stop-title').value = '';
    await selectRebus(state.selectedRebus.id);
  }

  async function loadLive() {
    if (state.mode === 'supabase') return loadSupabaseLive();
    if (!state.teacher) return;
    const data = await localApi('/api/admin/live');
    renderLive(data.participants || [], data.events || []);
  }

  async function loadSupabaseLive() {
    if (!state.selectedRebus) return renderLive([], []);
    const { data: students, error } = await state.supabase
      .from('students')
      .select('id, display_name, username, team_name, rebus_id, progress(points_awarded, correct, task_id, created_at), locations(latitude, longitude, accuracy, created_at), submissions(original_name, content_type, storage_path, storage_bucket, created_at), group_score_adjustments(points, reason, created_at)')
      .eq('rebus_id', state.selectedRebus.id);
    if (error) throw error;
    const participants = (students || []).map(student => {
      const progress = [...(student.progress || [])].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
      const completedProgress = progress.filter(item => item.correct !== false);
      const locations = [...(student.locations || [])].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
      const submissions = [...(student.submissions || [])].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
      const adjustments = student.group_score_adjustments || [];
      const latestSubmission = submissions[submissions.length - 1] || null;
      const latestProgress = completedProgress[completedProgress.length - 1] || null;
      const previousProgress = completedProgress[completedProgress.length - 2] || null;
      const adjustmentScore = adjustments.reduce((sum, item) => sum + Number(item.points || 0), 0);
      return {
        id: student.id,
        displayName: student.display_name,
        username: student.username,
        score: progress.reduce((sum, item) => sum + (item.points_awarded || 0), 0) + adjustmentScore,
        completedCount: completedProgress.length,
        latestProgressAt: latestProgress?.created_at || null,
        lastTransportMinutes: latestProgress && previousProgress
          ? Math.max(0, Math.round((new Date(latestProgress.created_at) - new Date(previousProgress.created_at)) / 60000))
          : null,
        latestLocation: locations.length ? {
          lat: locations[locations.length - 1].latitude,
          lng: locations[locations.length - 1].longitude
        } : null,
        latestSubmission: latestSubmission ? {
          originalName: latestSubmission.original_name || latestSubmission.storage_path,
          contentType: latestSubmission.content_type || '',
          url: '#'
        } : null
      };
    });
    renderLive(participants, []);
  }

  function renderLive(participants, events) {
    $('participant-count').textContent = String(participants.length);
    $('event-count').textContent = String(events.length);
    $('live-body').innerHTML = participants.length
      ? participants.map(participant => {
        const loc = participant.latestLocation;
        const locText = loc ? `<a href="https://www.google.com/maps?q=${loc.lat},${loc.lng}" target="_blank" rel="noreferrer">${Number(loc.lat).toFixed(5)}, ${Number(loc.lng).toFixed(5)}</a>` : '-';
        const submission = participant.latestSubmission;
        const submissionText = submission ? `<a href="${escapeHtml(submission.url)}" target="_blank" rel="noreferrer">${escapeHtml(submission.originalName)}</a><br><small>${escapeHtml(submission.contentType)}</small>` : '-';
        return `<tr><td>${escapeHtml(participant.displayName)}</td><td>${participant.score}</td><td>${participant.completedCount}</td><td>${formatClock(participant.latestProgressAt)}</td><td>${formatMinutes(participant.lastTransportMinutes)}</td><td>${locText}</td><td>${submissionText}</td></tr>`;
      }).join('')
      : '<tr><td colspan="7" class="muted">Ingen aktive elever ennå.</td></tr>';
    renderLiveMap(participants);
  }

  function formatClock(value) {
    if (!value) return '-';
    return new Date(value).toLocaleTimeString('no-NO', { hour: '2-digit', minute: '2-digit' });
  }

  function formatMinutes(value) {
    if (value === null || value === undefined) return '-';
    if (value < 1) return 'Under 1 min';
    return `${value} min`;
  }

  function renderLiveMap(participants) {
    const mapElement = $('live-map');
    if (!mapElement) return;
    const positioned = participants.filter(participant => participant.latestLocation);
    if (!positioned.length) {
      if (!state.liveMap) mapElement.textContent = 'Live-kart vises når grupper sender posisjon.';
      state.liveMarkers.forEach(marker => marker.setMap(null));
      state.liveMarkers.clear();
      return;
    }
    if (!window.google?.maps) {
      mapElement.textContent = 'Kartet lastes når Google Maps er klart.';
      return;
    }
    mapElement.classList.add('is-live');
    if (!state.liveMap) {
      state.liveMap = new google.maps.Map(mapElement, {
        center: positioned[0].latestLocation,
        zoom: 15,
        mapTypeControl: true,
        streetViewControl: false
      });
    }

    const activeIds = new Set();
    positioned.forEach((participant, index) => {
      const id = participant.id || participant.displayName || String(index);
      activeIds.add(id);
      const position = participant.latestLocation;
      const label = participant.displayName || `Gruppe ${index + 1}`;
      let marker = state.liveMarkers.get(id);
      if (!marker) {
        marker = new google.maps.Marker({
          map: state.liveMap,
          position,
          label: String(index + 1),
          title: label
        });
        state.liveMarkers.set(id, marker);
      }
      marker.setPosition(position);
      marker.setTitle(label);
      marker.setLabel(String(index + 1));
    });
    state.liveMarkers.forEach((marker, id) => {
      if (!activeIds.has(id)) {
        marker.setMap(null);
        state.liveMarkers.delete(id);
      }
    });
  }

  function loadScript(src, id = null) {
    return new Promise((resolve, reject) => {
      if (id) document.getElementById(id)?.remove();
      if (!id && document.querySelector(`script[src="${src}"]`)) return resolve();
      const script = document.createElement('script');
      if (id) script.id = id;
      script.src = src;
      script.async = true;
      script.defer = true;
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });
  }

  async function loadConfig() {
    if (window.REBUS_CONFIG) return normalizeConfig(window.REBUS_CONFIG);
    try {
      const response = await fetch('/api/config', { cache: 'no-store' });
      if (response.ok) return normalizeConfig(await response.json());
    } catch (_error) {
      // GitHub Pages has no local API. Fall back to local demo mode.
    }
    return normalizeConfig({});
  }

  function normalizeConfig(config) {
    return {
      supabaseUrl: config.supabaseUrl || '',
      supabaseAnonKey: config.supabaseAnonKey || '',
      googleClientId: config.googleClientId || '',
      googleMapsApiKey: config.googleMapsApiKey || '',
      allowDevAuth: config.allowDevAuth !== false,
      basePath: config.basePath || ''
    };
  }

  function appUrl(path = '') {
    const basePath = String(state.config?.basePath || '').replace(/\/$/, '');
    const cleanPath = String(path || '').replace(/^\//, '');
    return `${window.location.origin}${basePath}/${cleanPath}`;
  }

  function syncGroupUsername() {
    const suggested = slugify($('group-name').value);
    const current = $('group-username').value.trim();
    if (!current || current === state.lastSuggestedGroupUsername) {
      $('group-username').value = suggested;
      state.lastSuggestedGroupUsername = suggested;
    }
  }

  function setDefaultGroupFields() {
    if (!state.selectedRebus || !$('group-name')) return;
    const suggestedName = nextGroupName();
    const currentName = $('group-name').value.trim();
    if (!currentName || currentName === state.lastSuggestedGroupName) {
      $('group-name').value = suggestedName;
      state.lastSuggestedGroupName = suggestedName;
    }
    syncGroupUsername();
    seedGroupPassword();
  }

  function nextGroupName() {
    const existingNumbers = (state.selectedRebus?.students || [])
      .map(student => student.team_name || student.display_name || '')
      .map(name => String(name).match(/^gruppe\s+(\d+)$/i))
      .filter(Boolean)
      .map(match => Number(match[1]))
      .filter(Number.isFinite);
    const nextNumber = existingNumbers.length ? Math.max(...existingNumbers) + 1 : (state.selectedRebus?.students?.length || 0) + 1;
    return `Gruppe ${nextNumber}`;
  }

  function switchAdminTab(tab) {
    state.activeAdminTab = tab;
    document.querySelectorAll('[data-admin-tab]').forEach(button => {
      button.classList.toggle('active', button.dataset.adminTab === tab);
    });
    document.querySelectorAll('.admin-tab').forEach(panel => {
      panel.hidden = panel.id !== `tab-${tab}`;
    });
    if (tab === 'groups') setDefaultGroupFields();
    if (tab === 'access') renderAccessManagement();
    if (tab === 'submissions') refreshSelectedRebusForSubmissions().catch(error => alert(error.message));
    if (tab === 'chat') renderChatTab();
  }

  function seedGroupPassword() {
    if (!$('group-password').value) $('group-password').value = generateAccessCode();
  }

  function generateAccessCode() {
    const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    const numbers = '23456789';
    const specials = '!?#%';
    const all = `${letters}${numbers}${specials}`;
    const chars = [
      randomChar(letters),
      randomChar(numbers),
      randomChar(specials)
    ];
    while (chars.length < 6) chars.push(randomChar(all));
    return shuffle(chars).join('');
  }

  function randomChar(chars) {
    const array = new Uint32Array(1);
    crypto.getRandomValues(array);
    return chars[array[0] % chars.length];
  }

  function shuffle(items) {
    const copy = [...items];
    for (let index = copy.length - 1; index > 0; index -= 1) {
      const array = new Uint32Array(1);
      crypto.getRandomValues(array);
      const swapIndex = array[0] % (index + 1);
      [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
    }
    return copy;
  }

  function slugify(value) {
    return String(value || '')
      .trim()
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/æ/g, 'ae')
      .replace(/ø/g, 'o')
      .replace(/å/g, 'a')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  function normalizeRebusCode(value) {
    return String(value || '')
      .trim()
      .toUpperCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/Æ/g, 'AE')
      .replace(/Ø/g, 'O')
      .replace(/Å/g, 'A')
      .replace(/[^A-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32);
  }

  function suggestedRebusCode(title) {
    const orgPart = normalizeRebusCode(state.selectedOrganization?.name || 'ORG').split('-').filter(Boolean)[0] || 'ORG';
    const titleParts = normalizeRebusCode(title || 'REBUS').split('-').filter(Boolean);
    const titlePart = titleParts.slice(0, 2).join('-') || 'REBUS';
    return `${orgPart}-${titlePart}`.slice(0, 32);
  }

  function cssEscape(value) {
    if (window.CSS?.escape) return window.CSS.escape(value);
    return String(value).replace(/["\\]/g, '\\$&');
  }

  function showNotification(title, body) {
    const stack = $('notification-stack');
    if (!stack) return alert(`${title}\n${body}`);
    const item = document.createElement('div');
    item.className = 'app-notification';
    item.innerHTML = `<strong>${escapeHtml(title)}</strong><p>${escapeHtml(body)}</p>`;
    stack.appendChild(item);
    setTimeout(() => item.remove(), 9000);
  }

  function playNotificationSound() {
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      const audio = new AudioContext();
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(880, audio.currentTime);
      oscillator.frequency.setValueAtTime(660, audio.currentTime + 0.12);
      gain.gain.setValueAtTime(0.0001, audio.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.22, audio.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.35);
      oscillator.connect(gain);
      gain.connect(audio.destination);
      oscillator.start();
      oscillator.stop(audio.currentTime + 0.36);
    } catch (_error) {
      // Browsers may block sound until the page has had a user gesture.
    }
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  const escapeAttribute = escapeHtml;

  $('supabase-login-button').addEventListener('click', () => signInWithSupabaseGoogle().catch(error => alert(error.message)));
  $('email-login-button')?.addEventListener('click', () => signInWithEmailPassword().catch(error => setEmailAuthStatus(error.message)));
  $('email-signup-button')?.addEventListener('click', () => signUpWithEmailPassword().catch(error => setEmailAuthStatus(error.message)));
  $('logout-button').addEventListener('click', () => logout().catch(error => alert(error.message)));
  $('settings-logout-button').addEventListener('click', () => logout().catch(error => alert(error.message)));
  $('login-button').addEventListener('click', () => devLogin().catch(error => alert(error.message)));
  $('toggle-organization-picker-button').addEventListener('click', returnToOrganizationChoice);
  $('create-organization-button').addEventListener('click', () => createOrganization().catch(error => alert(error.message)));
  $('save-nickname-button').addEventListener('click', () => saveNickname().catch(error => alert(error.message)));
  $('invite-org-admin-button').addEventListener('click', () => inviteOrganizationAdmin().catch(error => alert(error.message)));
  $('invite-rebus-admin-button').addEventListener('click', () => inviteRebusAdmin().catch(error => alert(error.message)));
  $('access-invite-org-admin-button')?.addEventListener('click', () => inviteOrganizationAdmin().catch(error => alert(error.message)));
  $('access-invite-rebus-admin-button')?.addEventListener('click', () => inviteRebusAdmin().catch(error => alert(error.message)));
  $('save-settings-button').addEventListener('click', () => saveProjectSettings().catch(error => alert(error.message)));
  $('task-stop-select').addEventListener('change', event => {
    state.selectedStopId = event.target.value;
  });
  $('new-task-button').addEventListener('click', () => openTaskEditor(null));
  $('cancel-task-edit-button').addEventListener('click', closeTaskEditor);
  $('create-stop-button').addEventListener('click', () => createStopFromCurrentLocation().catch(error => alert(error.message)));
  $('task-type').addEventListener('change', updateTaskTypeUi);
  $('add-option-button').addEventListener('click', () => addOptionRow());
  $('add-asset-button').addEventListener('click', addAssetRow);
  $('add-hint-button').addEventListener('click', addHintRow);
  $('add-number-band-button').addEventListener('click', addNumberBand);
  document.querySelectorAll('[data-admin-tab]').forEach(button => {
    button.addEventListener('click', () => switchAdminTab(button.dataset.adminTab));
  });
  $('group-name').addEventListener('input', syncGroupUsername);
  $('group-password').addEventListener('focus', seedGroupPassword);
  $('generate-group-password-button').addEventListener('click', () => {
    $('group-password').value = generateAccessCode();
  });
  $('create-rebus-button').addEventListener('click', () => createRebus().catch(error => alert(error.message)));
  $('save-rebus-button').addEventListener('click', () => updateRebus().catch(error => alert(error.message)));
  $('delete-rebus-button').addEventListener('click', () => deleteRebus().catch(error => alert(error.message)));
  $('create-task-button').addEventListener('click', () => createTask().catch(error => alert(error.message)));
  $('create-student-button').addEventListener('click', () => createStudent().catch(error => alert(error.message)));
  $('export-groups-button').addEventListener('click', exportGroups);
  $('print-groups-button').addEventListener('click', printGroups);
  $('download-submissions-button').addEventListener('click', () => downloadSubmissionsZip().catch(error => alert(error.message)));
  $('delete-submissions-button').addEventListener('click', () => deleteAllSubmissions().catch(error => alert(error.message)));
  document.querySelectorAll('[data-close-submission-preview]').forEach(button => {
    button.addEventListener('click', closeSubmissionPreview);
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeSubmissionPreview();
  });
  $('use-current-location-button').addEventListener('click', useCurrentLocation);
  setInterval(() => loadLive().catch(() => {}), 5000);
  setInterval(() => loadGroupMessages().catch(() => {}), 6000);
  boot().catch(error => alert(error.message));
})();
