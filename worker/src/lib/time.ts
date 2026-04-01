export function nowMs(): number {
  return Date.now();
}

export function minuteEpochFromMs(timestampMs: number): number {
  return Math.floor(timestampMs / 60000);
}

export function msFromMinuteEpoch(minuteEpoch: number): number {
  return minuteEpoch * 60000;
}
