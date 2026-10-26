//! Isolated matcher for plugin-declared feature/window regexes. A catastrophic
//! pattern can only stall this worker; the main-thread caller terminates it on
//! timeout and continues with that rule omitted.

interface MatchRequest {
  requestId: number;
  query: string;
  patterns: { id: string; pattern: string }[];
}

interface MatchResponse {
  requestId: number;
  matched: string[];
}

const cache = new Map<string, RegExp | null>();
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<MatchRequest>) => void) | null;
  postMessage(message: MatchResponse): void;
};

function compiled(pattern: string): RegExp | null {
  if (cache.has(pattern)) return cache.get(pattern) ?? null;
  let value: RegExp | null = null;
  try {
    const candidate = new RegExp(pattern, "i");
    if (!candidate.test("")) value = candidate;
  } catch {
    value = null;
  }
  cache.set(pattern, value);
  return value;
}

scope.onmessage = (event) => {
  const { requestId, query, patterns } = event.data;
  const matched: string[] = [];
  for (const item of patterns) {
    const regex = compiled(item.pattern);
    if (regex?.test(query)) matched.push(item.id);
  }
  scope.postMessage({ requestId, matched });
};
