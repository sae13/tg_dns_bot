export type SendCommandParseResult =
  | { readonly status: 'not_send' }
  | { readonly status: 'malformed' }
  | { readonly status: 'valid'; readonly mailbox: string; readonly text: string };

export type InboxCommandParseResult =
  | { readonly status: 'not_inbox' }
  | { readonly status: 'malformed' }
  | { readonly status: 'valid'; readonly mailbox: string };

export type HelpCommandParseResult =
  | { readonly status: 'not_help' }
  | { readonly status: 'valid' };

const SEND_COMMAND = /^\/send(?=\s|$)/;
const INBOX_COMMAND = /^\/inbox(?=\s|$)/;
const WHITESPACE = /\s/;

export function parseSendCommand(input: string): SendCommandParseResult {
  const trimmed = input.trim();
  const command = SEND_COMMAND.exec(trimmed);
  if (command === null) return { status: 'not_send' };

  const argumentsStart = skipWhitespace(trimmed, command[0].length);
  if (argumentsStart === trimmed.length) return { status: 'malformed' };

  const mailboxEnd = findWhitespace(trimmed, argumentsStart);
  if (mailboxEnd === trimmed.length) return { status: 'malformed' };

  const textStart = skipWhitespace(trimmed, mailboxEnd);
  if (textStart === trimmed.length) return { status: 'malformed' };

  return {
    status: 'valid',
    mailbox: trimmed.slice(argumentsStart, mailboxEnd),
    text: trimmed.slice(textStart)
  };
}

export function parseHelpCommand(input: string): HelpCommandParseResult {
  return /^\/(?:help|start)$/u.test(input.trim())
    ? { status: 'valid' }
    : { status: 'not_help' };
}

export function parseInboxCommand(input: string): InboxCommandParseResult {
  const trimmed = input.trim();
  const command = INBOX_COMMAND.exec(trimmed);
  if (command === null) return { status: 'not_inbox' };

  const argumentsStart = skipWhitespace(trimmed, command[0].length);
  if (argumentsStart === trimmed.length) return { status: 'malformed' };

  const mailboxEnd = findWhitespace(trimmed, argumentsStart);
  if (mailboxEnd !== trimmed.length) return { status: 'malformed' };
  return { status: 'valid', mailbox: trimmed.slice(argumentsStart) };
}

function skipWhitespace(input: string, start: number): number {
  let index = start;
  while (index < input.length && WHITESPACE.test(input[index]!)) index += 1;
  return index;
}

function findWhitespace(input: string, start: number): number {
  let index = start;
  while (index < input.length && !WHITESPACE.test(input[index]!)) index += 1;
  return index;
}
