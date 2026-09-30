import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync('index.html', 'utf8');
const functionsStart = html.indexOf('function setFeedbackControlsDisabled(');
const functionsEnd = html.indexOf('function closeModal(', functionsStart);
assert.notEqual(functionsStart, -1, 'feedback state helpers exist');
assert.notEqual(functionsEnd, -1, 'feedback state helper block is complete');
const feedbackFunctions = html.slice(functionsStart, functionsEnd);

function makeContext(apiRequest, confirm = () => true) {
  const elements = {
    feedbackModal: { classList: { added: false, add() { this.added = true; } } },
    feedbackType: { value: 'issue', disabled: false },
    feedbackCategory: { value: '建議', disabled: false },
    feedbackMessage: { value: 'The progress page freezes after saving.', disabled: false },
    feedbackContact: { value: 'leader@example.org', disabled: false },
    feedbackMsg: { textContent: '', className: '' },
    btnSubmitFeedback: { textContent: 'Send', disabled: false },
    btnCloseFeedback: { textContent: 'Cancel', disabled: false }
  };
  const context = vm.createContext({
    document: { getElementById: id => elements[id] || null },
    currentTroopId: '0082',
    currentUser: { role: 'group_leader', name: 'Test leader', email: 'leader@example.org' },
    apiRequest,
    confirm,
    i18n: key => key
  });
  vm.runInContext("let feedbackSubmitState='idle';", context);
  vm.runInContext(feedbackFunctions, context);
  context.__elements = elements;
  return context;
}

test('feedback form shows pending and persistent confirmed states and ignores duplicate clicks', async () => {
  let resolveRequest; let calls = 0;
  const context = makeContext((action, data, options) => {
    calls++;
    assert.equal(action, 'submitFeedback');
    assert.equal(data.troopId, '0082');
    assert.equal(data.desc, 'The progress page freezes after saving.');
    assert.equal(options.timeout, 58000);
    return new Promise(resolve => { resolveRequest = resolve; });
  });
  const elements = context.__elements;

  const first = context.submitFeedback();
  const rapidRepeat = context.submitFeedback();
  assert.equal(calls, 1, 'a second click while the first request is pending is ignored');
  assert.equal(elements.feedbackMsg.className, 'login-msg pending');
  assert.equal(elements.feedbackMsg.textContent, 'support.sendingHint');
  assert.equal(elements.btnSubmitFeedback.disabled, true);
  assert.equal(elements.btnSubmitFeedback.textContent, 'support.sending');
  assert.equal(elements.btnCloseFeedback.disabled, true);
  assert.equal(elements.feedbackMessage.disabled, true);

  resolveRequest({ success: true, deliveryStatus: 'confirmed' });
  await Promise.all([first, rapidRepeat]);
  assert.equal(vm.runInContext('feedbackSubmitState', context), 'sent');
  assert.equal(elements.feedbackMsg.className, 'login-msg success');
  assert.equal(elements.feedbackMsg.textContent, 'support.confirmed');
  assert.equal(elements.feedbackMessage.value, 'The progress page freezes after saving.', 'the sent text stays visible for confirmation');
  assert.equal(elements.btnSubmitFeedback.disabled, true);
  assert.equal(elements.btnSubmitFeedback.textContent, 'support.sentButton');
  assert.equal(elements.btnCloseFeedback.textContent, 'support.close');

  await context.submitFeedback();
  assert.equal(calls, 1, 'a confirmed report cannot be submitted again from the same form');
});

test('ambiguous delivery warns against duplicates and requires explicit confirmation to resend', async () => {
  let calls = 0; let confirmations = 0; let allowResend = false;
  const context = makeContext(async () => {
    calls++;
    if (calls === 1) throw new Error('network timeout');
    return { success: true, deliveryStatus: 'confirmed' };
  }, () => { confirmations++; return allowResend; });
  const elements = context.__elements;

  await context.submitFeedback();
  assert.equal(vm.runInContext('feedbackSubmitState', context), 'unknown');
  assert.equal(elements.feedbackMsg.className, 'login-msg warning');
  assert.equal(elements.feedbackMsg.textContent, 'support.unknown');
  assert.equal(elements.btnSubmitFeedback.textContent, 'support.retryUnknown');
  assert.equal(elements.feedbackMessage.disabled, false, 'the report can be reviewed after a network problem');

  context.showFeedbackModal();
  assert.equal(elements.feedbackModal.classList.added, true);
  assert.equal(elements.feedbackMessage.value, 'The progress page freezes after saving.', 'reopening preserves the uncertain report and warning');
  assert.equal(elements.feedbackMsg.textContent, 'support.unknown');

  await context.submitFeedback();
  assert.equal(confirmations, 1);
  assert.equal(calls, 1, 'declining the duplicate-risk confirmation does not resend');
  allowResend = true;
  await context.submitFeedback();
  assert.equal(confirmations, 2);
  assert.equal(calls, 2);
  assert.equal(vm.runInContext('feedbackSubmitState', context), 'sent');
  assert.equal(elements.feedbackMsg.textContent, 'support.confirmed');
});

test('a legacy proxy error without delivery metadata is treated as ambiguous', async () => {
  const context = makeContext(async () => ({ success: false, error: 'Could not send your report.' }));
  const elements = context.__elements;

  await context.submitFeedback();
  assert.equal(vm.runInContext('feedbackSubmitState', context), 'unknown');
  assert.equal(elements.feedbackMsg.className, 'login-msg warning');
  assert.equal(elements.feedbackMsg.textContent, 'support.unknown');
  assert.equal(elements.btnSubmitFeedback.textContent, 'support.retryUnknown');
});

test('an explicit receiving-system rejection is presented as not accepted and can be retried', async () => {
  const context = makeContext(async () => ({
    success: false,
    deliveryStatus: 'rejected',
    error: 'rejected'
  }));
  const elements = context.__elements;

  await context.submitFeedback();
  assert.equal(vm.runInContext('feedbackSubmitState', context), 'failed');
  assert.equal(elements.feedbackMsg.className, 'login-msg error');
  assert.equal(elements.feedbackMsg.textContent, 'support.notAccepted');
  assert.equal(elements.btnSubmitFeedback.disabled, false);
  assert.equal(elements.feedbackMessage.value, 'The progress page freezes after saving.');
});
