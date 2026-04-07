export function isWithinReservation(now, reservation) {
  if (!reservation?.startsAt || !reservation?.endsAt) return false;
  const current = new Date(now).getTime();
  const start = new Date(reservation.startsAt).getTime();
  const end = new Date(reservation.endsAt).getTime();
  return current >= start && current <= end;
}

export function calculateContributedMinutes(sessionStartedAt, now = Date.now()) {
  if (!sessionStartedAt) return 0;
  return Math.max(0, Math.floor((now - new Date(sessionStartedAt).getTime()) / 60000));
}
