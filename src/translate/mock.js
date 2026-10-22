// Deterministic offline translator for tests and demos. Covers checks/fixtures/conversation.json.
const DICT = {
  'en>zh': {
    'Hello': '你好',
    'Hello.': '你好。',
    'Hello, nice to meet you.': '你好，很高兴认识你。',
    'Where is the train station?': '火车站在哪里？',
    'Thank you very much.': '非常感谢。',
    'Thank you.': '谢谢。',
    'Goodbye.': '再见。',
  },
  'zh>en': {
    '你好': 'Hello',
    '你好。': 'Hello.',
    '火车站在前面。': 'The train station is just ahead.',
    '不客气。': "You're welcome.",
    '谢谢。': 'Thank you.',
    '再见。': 'Goodbye.',
  },
};

export const name = 'mock';

export async function translate(text, from, to) {
  const src = String(text).trim();
  const hit = DICT[`${from}>${to}`]?.[src];
  return hit ?? `[${to}] ${src}`;
}
