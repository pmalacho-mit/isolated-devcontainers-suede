// Formats a duration for people.
export function formatDuration(ms) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return seconds + "s";
  return Math.floor(seconds / 60) + "m " + (seconds % 60) + "s";
}
