import { requireSupabase } from './supabase.js';
import { appState } from './state.js';
import { isApprovedMember } from './groups.js';
import { el, formatTime, icon, memberName, memberSymbol, renderIcons, setView, showToast } from './ui.js';

let chatChannel = null;
let answerChannel = null;

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

export function subscribeChat(onChanged) {
  unsubscribeChat();
  if (!appState.activeGroupId || !isApprovedMember()) return;
  const client = requireSupabase();
  chatChannel = client
    .channel(`messages:${appState.activeGroupId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'messages', filter: `group_id=eq.${appState.activeGroupId}` }, onChanged)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'questions', filter: `group_id=eq.${appState.activeGroupId}` }, onChanged)
    .subscribe();
  answerChannel = client
    .channel(`answers:${appState.activeGroupId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'question_answers', filter: `group_id=eq.${appState.activeGroupId}` }, onChanged)
    .subscribe();
}

export function unsubscribeChat() {
  const client = requireSupabase();
  [chatChannel, answerChannel].filter(Boolean).forEach((channel) => client.removeChannel(channel));
  chatChannel = null;
  answerChannel = null;
}

export function renderChat() {
  const view = document.querySelector('#chat-view');
  view.innerHTML = '';
  if (!appState.user) return;
  if (!appState.activeGroup) {
    view.append(el('div', { className: 'page narrow' }, [el('p', { className: 'panel muted', text: 'Välj eller skapa en grupp först.' })]));
    return;
  }
  if (!isApprovedMember()) {
    view.append(el('div', { className: 'page narrow' }, [el('p', { className: 'panel muted', text: 'Chatten öppnas när medlemskapet är godkänt.' })]));
    return;
  }
  const list = el('div', { className: 'message-list' }, appState.messages.map((message) => renderMessage(message)));
  view.append(el('div', { className: 'chat-layout' }, [list, composer()]));
  queueMicrotask(() => {
    list.scrollTop = list.scrollHeight;
    renderIcons();
  });
}

function renderMessage(message) {
  if (message.type === 'question') return renderQuestionMessage(message);
  const location = message.type === 'location';
  return el('article', { className: `message message-${message.type}` }, [
    el('div', { className: 'message-avatar', text: memberSymbol(message.user_id) }),
    el('div', { className: 'message-body' }, [
      el('div', { className: 'message-meta' }, [el('strong', { text: memberName(message.user_id) }), el('time', { text: formatTime(message.created_at) })]),
      el('p', { text: location ? `📍 ${message.text || 'Plats'}` : message.text }),
      location
        ? el(
            'button',
            {
              className: 'link-button',
              onClick: () => {
                appState.mapTarget = { latitude: message.latitude, longitude: message.longitude, text: message.text };
                setView('map');
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
  return el('article', { className: 'message question-card' }, [
    el('div', { className: 'message-avatar', text: memberSymbol(message.user_id) }),
    el('div', { className: 'message-body stack' }, [
      el('div', { className: 'message-meta' }, [el('strong', { text: memberName(message.user_id) }), el('time', { text: formatTime(message.created_at) })]),
      el('h3', { text: question.question_text }),
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
        el('p', { text: `Svarat: ${answers.map((answer) => `${answer.profiles?.alias || memberName(answer.user_id)} - ${answer.question_options?.label || ''}`).join(', ') || 'Ingen ännu'}` }),
        el('p', { text: `Ej svarat: ${approved.filter((member) => !answeredIds.has(member.user_id)).map((member) => member.profiles?.alias || 'Okänd').join(', ') || 'Alla har svarat'}` }),
      ]),
    ]),
  ]);
}

function composer() {
  const mode = el('select', {}, [
    el('option', { value: 'text', text: 'Nytt meddelande' }),
    el('option', { value: 'question', text: 'Ny fråga' }),
  ]);
  const text = el('textarea', { rows: '2', placeholder: 'Skriv meddelande' });
  const options = el('input', { placeholder: 'Svarsalternativ, separera med kommatecken' });
  const optionsLabel = el('label', { hidden: true }, ['Alternativ', options]);
  mode.addEventListener('change', () => {
    const isQuestion = mode.value === 'question';
    text.placeholder = isQuestion ? 'Frågetext' : 'Skriv meddelande';
    optionsLabel.hidden = !isQuestion;
  });
  const submit = async (event) => {
    event.preventDefault();
    try {
      if (mode.value === 'question') {
        await createQuestion(text.value.trim(), options.value.split(',').map((item) => item.trim()).filter(Boolean));
      } else {
        await sendMessage(text.value.trim());
      }
      text.value = '';
      options.value = '';
    } catch (error) {
      console.error(error);
      showToast('Kunde inte skicka.', 'error');
    }
  };
  return el('form', { className: 'composer', onSubmit: submit }, [
    mode,
    text,
    optionsLabel,
    el('button', { className: 'primary', type: 'submit' }, [icon('send', 'Skicka'), 'Skicka']),
  ]);
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
  } catch (error) {
    console.error(error);
    showToast('Kunde inte spara svaret.', 'error');
  }
}
