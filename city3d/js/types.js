/* TypePop City 3D — shared per-type data.
 * Extracted from ~/workspace/personality-test/app/src/types.ts (2026-10-23).
 * Used by both the 3D city shell (house colors, name tags) and the
 * HD-2D interior module (room re-skin, resident dialogue).
 */
export const TYPES = [
  { key: 'enfp', name: 'ENFP', nickname: 'The Hype Machine', palName: 'Pip',    color: '#FF8C69', prop: 'party popper',
    oneLiners: ['Dance break! Prescribing one (1) immediately.', 'Have you met EVERYONE yet? You should!', 'New idea! It is DEFINITELY safe.'] },
  { key: 'intj', name: 'INTJ', nickname: 'The Chess Player', palName: 'Nova',   color: '#3B4A6B', prop: 'chess piece',
    oneLiners: ['I have already simulated this conversation. It went well.', 'Efficiency is my love language.', 'Your schedule has been optimized. I did not ask.'] },
  { key: 'enfj', name: 'ENFJ', nickname: 'The Cheerleader', palName: 'Sunny',   color: '#FF6B6B', prop: 'megaphone',
    oneLiners: ['You did AMAZING today and I need you to know that.', 'Group hug! Attendance is mandatory.', 'You are the protagonist today. I make the rules.'] },
  { key: 'entj', name: 'ENTJ', nickname: 'The Commander', palName: 'Rex',       color: '#8B5CF6', prop: 'scepter',
    oneLiners: ["I made a 5-year plan for us. You're welcome.", 'Excuses: zero. Results: incoming.', 'Nap efficiency is up 40%. Keep it up.'] },
  { key: 'entp', name: 'ENTP', nickname: 'The Debater', palName: 'Zip',         color: '#F59E0B', prop: 'lightbulb',
    oneLiners: ["Devil's advocate here: what if naps are a conspiracy?", 'I can argue any side of this. Want a demo?', 'What if the rug… was a trampoline?'] },
  { key: 'infj', name: 'INFJ', nickname: 'The Counselor', palName: 'Milo',      color: '#6D9DC5', prop: 'lantern',
    oneLiners: ['I knew you were going to tap me. I always know.', 'Tell me about your day. I will read between the lines.', 'I have been saving you a spot by the window.'] },
  { key: 'infp', name: 'INFP', nickname: 'The Dreamer', palName: 'Wisp',       color: '#A8E6CF', prop: 'flower',
    oneLiners: ['I wrote a poem about this rug. Want to hear it?', 'That cloud told me a secret. Want to know?', 'I named all the dust motes. This one is Gerald.'] },
  { key: 'intp', name: 'INTP', nickname: 'The Thinker', palName: 'Pip',         color: '#8B9BB4', prop: 'beaker',
    oneLiners: ['Hypothesis: snacks improve everything. Testing now.'] },
  { key: 'esfp', name: 'ESFP', nickname: 'The Entertainer', palName: 'Pip',     color: '#FFD93D', prop: 'maraca',
    oneLiners: ['Dance break! No arguments!'] },
  { key: 'esfj', name: 'ESFJ', nickname: 'The Caregiver', palName: 'Pip',       color: '#FFB59E', prop: 'gift box',
    oneLiners: ['I saved you the good cushion. Obviously.'] },
  { key: 'estp', name: 'ESTP', nickname: 'The Daredevil', palName: 'Pip',       color: '#FF5A3C', prop: 'lightning bolt',
    oneLiners: ['Bet I can hop higher than you. Watch.'] },
  { key: 'estj', name: 'ESTJ', nickname: 'The Executive', palName: 'Pip',       color: '#4A5F8A', prop: 'clipboard',
    oneLiners: ["The nap schedule has been optimized. You're welcome."] },
  { key: 'isfp', name: 'ISFP', nickname: 'The Artist', palName: 'Pip',         color: '#4ECDC4', prop: 'paint palette',
    oneLiners: ['This wall needs more… everything. Hold my brush.'] },
  { key: 'istp', name: 'ISTP', nickname: 'The Crafter', palName: 'Pip',         color: '#8A9A5B', prop: 'wrench',
    oneLiners: ['I fixed the wobble in the table. You’re welcome.'] },
  { key: 'isfj', name: 'ISFJ', nickname: 'The Defender', palName: 'Pip',        color: '#E8B84B', prop: 'shield',
    oneLiners: ["I'll keep watch while you rest. It's what I do."] },
  { key: 'istj', name: 'ISTJ', nickname: 'The Inspector', palName: 'Pip',      color: '#7B8BA3', prop: 'wristwatch',
    oneLiners: ['Nap logged at 14:32. Duration: optimal.'] },
];

export const typeByKey = (key) => TYPES.find((t) => t.key === key) || TYPES[0];
