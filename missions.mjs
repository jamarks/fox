// Missions are local, manually assigned links. Missing members stay in state so a temporarily
// unavailable session, job or PR never silently loses its association.
import { randomUUID } from 'node:crypto';

const TYPES = ['session', 'job', 'pr'];
export const prLink = (url) => /^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/pull\/[1-9]\d{0,6}$/.test(url);
const bad = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
export function missionsOf(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((m) => m && typeof m.id === 'string' && typeof m.name === 'string' && Array.isArray(m.members))
    .map((m) => ({ id: m.id, name: m.name, members: m.members.filter((x) => x && TYPES.includes(x.type) && typeof x.id === 'string') }));
}
export function createMission(missions, name) {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 60) bad('Name must be 1–60 characters');
  const mission = { id: randomUUID(), name: name.trim(), members: [] };
  missions.push(mission);
  return mission;
}
export function setMember(missions, { type, id, missionId }, exists) {
  if (!TYPES.includes(type) || typeof id !== 'string' || !id || (type === 'pr' && !prLink(id))) bad('Invalid member');
  if (missionId !== null && (typeof missionId !== 'string' || !missions.some((m) => m.id === missionId))) bad('Unknown mission', 404);
  const previous = missions.find((m) => m.members.some((x) => x.type === type && x.id === id));
  if (missionId !== null && !exists(type, id) && !previous) bad('Member not found', 404);
  for (const m of missions) m.members = m.members.filter((x) => x.type !== type || x.id !== id);
  if (missionId !== null) missions.find((m) => m.id === missionId).members.push({ type, id });
}
export function missionFor(missions, type, id) {
  return missions.find((m) => m.members.some((x) => x.type === type && x.id === id))?.id ?? null;
}
export function decorateSessions(sessions, missions) {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  return sessions.map((s) => {
    // A child follows its root session; a child is never assigned independently.
    let root = s, seen = new Set([s.id]);
    while (root.parentId && byId.has(root.parentId) && !seen.has(root.parentId)) {
      root = byId.get(root.parentId); seen.add(root.id);
    }
    return { ...s, missionId: missionFor(missions, 'session', root.id) };
  });
}
