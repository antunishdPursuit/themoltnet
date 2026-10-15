import { readFileSync } from 'node:fs';

import { env } from './config.js';
import { ADAPTIVE_REVIEW_MARKER, renderAdaptiveComment } from './report.js';
import type { AdaptiveReport } from './workflow.js';

async function main() {
  const path = env().ADAPTIVE_REPORT;
  const token = env().GH_TOKEN;
  const runUrl = env().ADAPTIVE_RUN_URL;
  if (!path || !token || !runUrl)
    throw new Error('report, App token, and run URL are required');
  const report = JSON.parse(readFileSync(path, 'utf8')) as AdaptiveReport;
  const api = env().GITHUB_API_URL || 'https://api.github.com';
  const request = async (
    url: string,
    method = 'GET',
    body?: object,
  ): Promise<unknown> => {
    const response = await fetch(`${api}${url}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'x-github-api-version': '2022-11-28',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error(`GitHub API returned ${response.status}`);
    return response.status === 204
      ? null
      : ((await response.json()) as unknown);
  };
  const current = (await request(
    `/repos/${report.repo}/pulls/${report.pr}`,
  )) as { head: { sha: string } };
  if (current.head.sha !== report.head)
    throw new Error('PR head changed; refusing to publish stale review');
  const body = renderAdaptiveComment(report, runUrl);
  const login = env().ADAPTIVE_APP_LOGIN;
  let previous: { id: number } | undefined;
  for (let page = 1; page <= 100 && !previous; page++) {
    const comments = (await request(
      `/repos/${report.repo}/issues/${report.pr}/comments?per_page=100&page=${page}`,
    )) as Array<{ id: number; body: string; user: { login: string } }>;
    previous = comments.find(
      (comment) =>
        comment.body.includes(ADAPTIVE_REVIEW_MARKER) &&
        (!login || comment.user.login === login),
    );
    if (comments.length < 100) break;
  }
  const latest = (await request(
    `/repos/${report.repo}/pulls/${report.pr}`,
  )) as {
    head: { sha: string };
  };
  if (latest.head.sha !== report.head)
    throw new Error('PR head changed before publishing review');
  if (previous) {
    await request(
      `/repos/${report.repo}/issues/comments/${previous.id}`,
      'PATCH',
      { body },
    );
  } else {
    await request(
      `/repos/${report.repo}/issues/${report.pr}/comments`,
      'POST',
      { body },
    );
  }
}

main().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
