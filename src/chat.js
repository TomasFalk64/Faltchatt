import { requireSupabase } from './supabase.js';
import { appState } from './state.js';
import { isApprovedMember } from './groups.js';
import { el, formatTime, friendlyError, icon, memberColor, memberName, memberSymbolId, renderIcons, showToast, symbolNode, updateNavBadges } from './ui.js';

let chatChannel = null;
let answerChannel = null;
let chatRefreshTimer = null;
const messageSound = new Audio(`${import.meta.env.BASE_URL}data/golgroda.mp3`);
let soundUnlocked = false;

messageSound.preload = 'auto';
messageSound.volume = 0.75;

['pointerdown', 'keydown'].forEach((eventName) => {
  document.addEventListener(eventName, unlockMessageSound, { once: true });
});

export async function loadChatData() {
  if (!appState.activeGroupId || !isApprovedMember()) {
    appState.messages = [];
    appState.questions = new Map();
    appState.answers = [];
    return;
  }
  const client = requireSupabase();
  const [{ data: messages, error: messageError }, { data: questions, error: questionError }, { data: answers, error: answerError }] =
    await Promise.all([
      client.from('messages').select('*').eq('group_id', appState.activeGroupId).order('created_at', { ascending: true }).limit(150),
      client
        .from('questions')
        .select('*, question_options(*)')
        .eq('group_id', appState.activeGroupId)
        .order('created_at', { ascending: true }),
      client
        .from('question_answers')
        .select('*, question_options(label), profiles(alias)')
        .eq('group_id', appState.activeGroupId),
    ]);
  if (messageError) throw messageError;
  if (questionError) throw questionError;
  if (answerError) throw answerError;
  appState.messages = messages || [];
  appState.questions = new Map((questions || []).map((question) => [question.message_id, question]));
  appState.answers = answers || [];
}

export function subscribeChat(onMessageChanged, onChanged) {
  unsubscribeChat();
  if (!appState.activeGroupId || !isApprovedMember()) return;
  const client = requireSupabase();
  chatChannel = client
    .channel(`messages:${appState.activeGroupId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'messages', filter: `group_id=eq.${appState.activeGroupId}` }, onMessageChanged)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'questions', filter: `group_id=eq.${appState.activeGroupId}` }, onChanged)
    .subscribe();
  answerChannel = client
    .channel(`answers:${appState.activeGroupId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'question_answers', filter: `group_id=eq.${appState.activeGroupId}` }, onChanged)
    .subscribe();
  chatRefreshTimer = window.setInterval(onChanged, 20000);
}

export function unsubscribeChat() {
  const client = requireSupabase();
  [chatChannel, answerChannel].filter(Boolean).forEach((channel) => client.removeChannel(channel));
  chatChannel = null;
  answerChannel = null;
  if (chatRefreshTimer) window.clearInterval(chatRefreshTimer);
  chatRefreshTimer = null;
}

export function renderChat() {
  const view = document.querySelector('#chat-view');
  view.innerHTML = '';
  if (!appState.user) return;
  if (!appState.activeGroup) {
    view.append(el('div', { className: 'page narrow' }, [el('p', { className: 'panel muted', text: 'Välj grupp för att se chatt.' })]));
    return;
  }
  if (!isApprovedMember()) {
    view.append(el('div', { className: 'page narrow' }, [el('p', { className: 'panel muted', text: 'Chatten öppnas när medlemskapet är godkänt.' })]));
    return;
  }
  const list = el('div', { id: 'chat-message-list', className: 'message-list' }, appState.messages.map((message) => renderMessage(message)));
  list.dataset.signature = chatSignature();
  list.addEventListener('scroll', () => updateChatReadState(list));
  view.append(el('div', { className: 'chat-layout sidebar-chat' }, [
    el('div', { className: 'tab-kicker chat-kicker', text: 'CHATT' }),
    list,
    composer(),
  ]));
  queueMicrotask(() => {
    scrollMessageListToBottom(list);
    renderIcons();
  });
}

export async function refreshChatMessages() {
  const previousIds = new Set(appState.messages.map((message) => message.id));
  await loadChatData();
  notifyForNewMessages(previousIds);
  renderMessageList();
}

export function applyMessagePayload(payload) {
  const beforeLocations = locationMessageSignature();
  const previousIds = new Set(appState.messages.map((message) => message.id));
  const row = payload.new || payload.old;
  if (!row || row.group_id !== appState.activeGroupId) return false;

  if (payload.eventType === 'DELETE') {
    appState.messages = appState.messages.filter((message) => message.id !== row.id);
  } else if (row.type === 'question') {
    return null;
  } else {
    const index = appState.messages.findIndex((message) => message.id === row.id);
    if (index >= 0) appState.messages[index] = { ...appState.messages[index], ...row };
    else appState.messages.push(row);
    appState.messages.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  }

  notifyForNewMessages(previousIds);
  renderMessageList();
  return locationMessageSignature() !== beforeLocations;
}

function notifyForNewMessages(previousIds) {
  const hasNewFromOther = appState.messages.some((message) => !previousIds.has(message.id) && message.user_id !== appState.user?.id);
  if (!hasNewFromOther) return;
  const list = document.querySelector('#chat-message-list');
  const nearBottom = list ? list.scrollHeight - list.scrollTop - list.clientHeight < 120 : false;
  if (appState.selectedView !== 'chat' || !nearBottom) {
    appState.unreadChat = true;
    updateNavBadges();
  }
  playMessageSound();
}

async function unlockMessageSound() {
  try {
    messageSound.muted = true;
    await messageSound.play();
    messageSound.pause();
    messageSound.currentTime = 0;
    messageSound.muted = false;
    soundUnlocked = true;
  } catch {
    soundUnlocked = false;
  }
}

function playMessageSound() {
  if (!soundUnlocked) return;
  try {
    messageSound.currentTime = 0;
    messageSound.play().catch(() => {});
  } catch {
    // Browser audio policies can still block sound until the page has been interacted with.
  }
}

function renderMessageList() {
  const list = document.querySelector('#chat-message-list');
  if (!list) {
    renderChat();
    return;
  }
  const signature = chatSignature();
  if (list.dataset.signature === signature) return;
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 120;
  list.replaceChildren(...appState.messages.map((message) => renderMessage(message)));
  list.dataset.signature = signature;
  if (nearBottom) scrollMessageListToBottom(list);
  updateChatReadState(list);
  renderIcons();
}

function updateChatReadState(list) {
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 24;
  if (appState.selectedView === 'chat' && atBottom) {
    appState.unreadChat = false;
    updateNavBadges();
  }
}

function scrollMessageListToBottom(list) {
  requestAnimationFrame(() => {
    list.scrollTop = list.scrollHeight;
    requestAnimationFrame(() => {
      list.scrollTop = list.scrollHeight;
    });
  });
}

function chatSignature() {
  return [
    appState.messages.map((message) => `${message.id}:${message.created_at}:${message.text}`).join('|'),
    appState.answers.map((answer) => `${answer.question_id}:${answer.user_id}:${answer.option_id}`).join('|'),
  ].join('::');
}

function locationMessageSignature() {
  return appState.messages
    .filter((message) => message.type === 'location' && message.latitude && message.longitude)
    .map((message) => `${message.id}:${message.latitude}:${message.longitude}:${message.text}`)
    .join('|');
}

function renderMessage(message) {
  if (message.type === 'question') return renderQuestionMessage(message);
  const location = message.type === 'location';
  const own = message.user_id === appState.user?.id;
  const details = `${memberName(message.user_id)} ${formatTime(message.created_at)}`;
  return el('article', { className: `message message-${message.type} ${own ? 'own-message' : ''}` }, [
    el('div', { className: 'message-body' }, [
      el('div', { className: 'message-line' }, [
        el('button', {
          type: 'button',
          className: 'message-symbol-button',
          title: details,
          'aria-label': details,
          onClick: (event) => showMessageDetails(event.currentTarget, details),
        }, [
          Object.assign(symbolNode(memberSymbolId(message.user_id), 'message-inline-symbol'), { style: `color: ${memberColor(message.user_id)}` }),
        ]),
        el('p', { text: location ? `Plats: ${message.text || 'Plats'}` : message.text }),
      ]),
      location
        ? el(
            'button',
            {
              className: 'link-button',
              onClick: () => {
                appState.mapTarget = { messageId: message.id, latitude: message.latitude, longitude: message.longitude, text: message.text };
                window.dispatchEvent(new CustomEvent('faltchatt:focus-location'));
              },
            },
            [icon('map-pin', 'Visa'), 'Visa på kartan'],
          )
        : null,
    ]),
  ]);
}

function renderQuestionMessage(message) {
  const question = appState.questions.get(message.id);
  if (!question) return renderMessage({ ...message, type: 'text' });
  const answers = appState.answers.filter((answer) => answer.question_id === question.id);
  const answeredIds = new Set(answers.map((answer) => answer.user_id));
  const approved = appState.members.filter((member) => member.status === 'approved');
  const own = message.user_id === appState.user?.id;
  const details = `${memberName(message.user_id)} ${formatTime(message.created_at)}`;
  return el('article', { className: `message question-card ${own ? 'own-message' : ''}` }, [
    el('div', { className: 'message-body stack' }, [
      el('div', { className: 'message-line' }, [
        el('button', {
          type: 'button',
          className: 'message-symbol-button',
          title: details,
          'aria-label': details,
          onClick: (event) => showMessageDetails(event.currentTarget, details),
        }, [
          Object.assign(symbolNode(memberSymbolId(message.user_id), 'message-inline-symbol'), { style: `color: ${memberColor(message.user_id)}` }),
        ]),
        el('h3', { text: question.question_text }),
      ]),
      el(
        'div',
        { className: 'option-grid' },
        [...(question.question_options || [])]
          .sort((a, b) => a.sort_order - b.sort_order)
          .map((option) =>
            el(
              'button',
              {
                className: answers.some((answer) => answer.user_id === appState.user.id && answer.option_id === option.id) ? 'selected-option' : '',
                onClick: () => answerQuestion(question.id, option.id),
              },
              [option.label, el('small', { text: String(answers.filter((answer) => answer.option_id === option.id).length) })],
            ),
          ),
      ),
      el('details', {}, [
        el('summary', { text: 'Svar och ej svarat' }),
        el('p', { text: `Svarat: ${answers.map((answer) => `${answerLabel(answer.user_id)} - ${answer.question_options?.label || ''}`).join(', ') || 'Ingen ännu'}` }),
        el('p', { text: `Ej svarat: ${approved.filter((member) => !answeredIds.has(member.user_id)).map((member) => answerLabel(member.user_id)).join(', ') || 'Alla har svarat'}` }),
      ]),
    ]),
  ]);
}

function showMessageDetails(anchor, text) {
  document.querySelectorAll('.message-detail-popover').forEach((node) => node.remove());
  const popover = el('div', { className: 'message-detail-popover', text });
  document.body.append(popover);
  const rect = anchor.getBoundingClientRect();
  const popoverRect = popover.getBoundingClientRect();
  const left = Math.min(
    window.innerWidth - popoverRect.width - 8,
    Math.max(8, rect.left + rect.width / 2 - popoverRect.width / 2),
  );
  const top = Math.max(8, rect.top - popoverRect.height - 8);
  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;

  const close = (event) => {
    if (event?.target === anchor || popover.contains(event?.target)) return;
    popover.remove();
    document.removeEventListener('pointerdown', close, true);
    document.removeEventListener('keydown', close, true);
  };
  window.setTimeout(() => {
    document.addEventListener('pointerdown', close, true);
    document.addEventListener('keydown', close, true);
  }, 0);
  window.setTimeout(() => {
    popover.remove();
    document.removeEventListener('pointerdown', close, true);
    document.removeEventListener('keydown', close, true);
  }, 4500);
}

function answerLabel(userId) {
  return memberName(userId);
}

function composer() {
  let mode = 'text';
  const modeToggle = el('button', { type: 'button', className: 'mode-toggle', text: 'Text' });
  const text = el('textarea', { className: 'composer-text', rows: '2', placeholder: 'Skriv meddelande' });
  const options = el('input', { placeholder: 'Alternativ, t.ex. kaffe, te, saft' });
  const optionsRow = el('div', { className: 'composer-options', hidden: true }, [options]);
  const inputStack = el('div', { className: 'composer-inputs' }, [text, optionsRow]);
  const form = el('form', { className: 'composer text-mode' });

  modeToggle.addEventListener('click', () => {
    mode = mode === 'text' ? 'question' : 'text';
    const isQuestion = mode === 'question';
    modeToggle.textContent = isQuestion ? 'Fråga' : 'Text';
    text.placeholder = isQuestion ? 'Frågetext, t.ex. Fika?' : 'Skriv meddelande';
    optionsRow.hidden = !isQuestion;
    form.classList.toggle('poll-mode', isQuestion);
    form.classList.toggle('text-mode', !isQuestion);
  });

  const submit = async (event) => {
    event.preventDefault();
    try {
      if (mode === 'question') {
        await createQuestion(text.value.trim(), options.value.split(',').map((item) => item.trim()).filter(Boolean));
        await refreshChatMessages();
      } else {
        await sendMessage(text.value.trim());
      }
      text.value = '';
      options.value = '';
    } catch (error) {
      console.error(error);
      showToast(friendlyError(error, 'Kunde inte skicka.'), 'error');
    }
  };

  form.addEventListener('submit', submit);
  form.append(
    modeToggle,
    inputStack,
    el('button', { className: 'primary send-button', type: 'submit', title: 'Skicka', 'aria-label': 'Skicka' }, [icon('send', 'Skicka')]),
  );
  return form;
}

export async function sendMessage(text, extra = {}) {
  if (!text && !extra.latitude) return;
  const { error } = await requireSupabase().from('messages').insert({
    group_id: appState.activeGroupId,
    user_id: appState.user.id,
    type: extra.type || 'text',
    text,
    latitude: extra.latitude || null,
    longitude: extra.longitude || null,
  });
  if (error) throw error;
}

async function createQuestion(questionText, labels) {
  if (!questionText || labels.length < 2) {
    showToast('En fråga behöver text och minst två alternativ.', 'warning');
    return;
  }
  const { error } = await requireSupabase().rpc('create_question_message', {
    target_group_id: appState.activeGroupId,
    question_text: questionText,
    option_labels: labels,
  });
  if (error) throw error;
}

async function answerQuestion(questionId, optionId) {
  try {
    const { error } = await requireSupabase().from('question_answers').upsert(
      {
        question_id: questionId,
        group_id: appState.activeGroupId,
        option_id: optionId,
        user_id: appState.user.id,
      },
      { onConflict: 'question_id,user_id' },
    );
    if (error) throw error;
    await refreshChatMessages();
  } catch (error) {
    console.error(error);
    showToast(friendlyError(error, 'Kunde inte spara svaret.'), 'error');
  }
}

