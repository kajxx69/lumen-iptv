export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
