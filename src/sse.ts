export interface SseBlock {
  data: string;
  event: string;
}

export function parseSseBlock(block: string): SseBlock {
  let event = "message";
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("event:")) {
      event = trimmed.slice("event:".length).trim() || event;
      continue;
    }
    const value = sseDataFromLine(trimmed);
    if (value !== undefined) {
      data.push(value);
    }
  }
  return { data: data.join("\n"), event };
}

export function sseDataFromLine(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) {
    return undefined;
  }
  return trimmed.slice("data:".length).trim();
}

export function encodeSseEvent(event: string, data: object | "[DONE]"): string {
  if (data === "[DONE]") {
    return "data: [DONE]\n\n";
  }
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function encodeSseData(data: object | "[DONE]"): string {
  if (data === "[DONE]") {
    return "data: [DONE]\n\n";
  }
  return `data: ${JSON.stringify(data)}\n\n`;
}
