import axios from 'axios';
import { z } from 'zod';
import './util.js';

const jiraConfigSchema = z.object({
  baseUrl: z.string().url(),
  email: z.string().email(),
  apiToken: z.string().min(1),
});

function getClient() {
  const config = jiraConfigSchema.parse({
    baseUrl: process.env.JIRA_BASE_URL?.replace(/\/+$/, ''),
    email: process.env.JIRA_EMAIL,
    apiToken: process.env.JIRA_API_TOKEN,
  });
  return axios.create({
    baseURL: `${config.baseUrl}/rest/api/3`,
    timeout: Number(process.env.JIRA_TIMEOUT_MS) || 30000,
    auth: { username: config.email, password: config.apiToken },
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
  });
}

function plainText(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  if (value.type === 'hardBreak') return '\n';
  if (value.type === 'text' && typeof value.text === 'string') return value.text;
  const children = Array.isArray(value.content) ? value.content : [];
  const text = children.map(plainText).filter(Boolean).join('');
  return ['paragraph', 'heading', 'listItem', 'blockquote', 'codeBlock'].includes(value.type) ? `${text}\n` : text;
}

const AC_FIELD = process.env.JIRA_AC_FIELD || '';
const COMMENT_LIMIT = Math.max(0, Number(process.env.JIRA_COMMENT_LIMIT ?? 10) || 0);
const MAX_COMMENT_CHARS = 2000;

function recentComments(commentField) {
  const comments = Array.isArray(commentField?.comments) ? commentField.comments : [];
  if (COMMENT_LIMIT === 0) return '';
  return comments.slice(-COMMENT_LIMIT)
    .map((comment) => `[${comment.author?.displayName || 'Unknown'} ${comment.created || ''}] ${plainText(comment.body).trim().slice(0, MAX_COMMENT_CHARS)}`)
    .filter((line) => line.trim())
    .join('\n');
}

function normalizeIssue(issue, baseUrl) {
  const fields = issue.fields || {};
  return {
    key: issue.key,
    id: issue.id,
    url: `${baseUrl}/browse/${encodeURIComponent(issue.key)}`,
    summary: fields.summary || '(No summary)',
    description: plainText(fields.description),
    status: fields.status?.name || '',
    assignee: fields.assignee?.displayName || '',
    issueType: fields.issuetype?.name || '',
    project: fields.project?.key || '',
    components: (fields.components || []).map((component) => component.name).filter(Boolean),
    labels: Array.isArray(fields.labels) ? fields.labels : [],
    acceptanceCriteria: AC_FIELD ? plainText(fields[AC_FIELD]).trim() : '',
    comments: recentComments(fields.comment),
  };
}

/** Fetch all issues assigned to the authenticated current user in the requested workflow states. */
export async function fetchActiveTickets() {
  const client = getClient();
  const baseUrl = client.defaults.baseURL.replace(/\/rest\/api\/3$/, '');
  const statuses = ['Accepted into Sprint', 'Development', 'Dev testing'];
  const jqlStatuses = statuses.map((status) => `"${status.replaceAll('"', '\\"')}"`).join(', ');
  const jql = `assignee = currentUser() AND status in (${jqlStatuses}) ORDER BY updated DESC`;
  const fields = ['summary', 'description', 'status', 'assignee', 'issuetype', 'project', 'components', 'labels', 'comment', ...(AC_FIELD ? [AC_FIELD] : [])];
  const pageSize = Math.max(1, Math.min(Number(process.env.JIRA_PAGE_SIZE) || 100, 100));
  const tickets = [];
  let nextPageToken;

  while (true) {
    const { data } = await client.post('/search/jql', {
      jql,
      maxResults: pageSize,
      fields,
      ...(nextPageToken ? { nextPageToken } : {}),
    });
    const issues = Array.isArray(data?.issues) ? data.issues : [];
    tickets.push(...issues.map((issue) => normalizeIssue(issue, baseUrl)));
    nextPageToken = data?.nextPageToken;
    if (issues.length === 0 || data?.isLast === true || !nextPageToken) break;
  }
  return tickets;
}

/** Post a plain-text internal comment (one paragraph per line). This is opt-in from the orchestrator. */
export async function postJiraComment(issueKey, text) {
  if (!issueKey || !text) throw new Error('An issue key and comment text are required.');
  const client = getClient();
  const paragraphs = String(text).split('\n').filter((line) => line.trim())
    .map((line) => ({ type: 'paragraph', content: [{ type: 'text', text: line }] }));
  await client.post(`/issue/${encodeURIComponent(issueKey)}/comment`, {
    body: { type: 'doc', version: 1, content: paragraphs },
    // Jira Service Management: keep automation comments internal, never visible to the customer.
    properties: [{ key: 'sd.public.comment', value: { internal: true } }],
  });
}
