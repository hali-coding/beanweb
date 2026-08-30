#!/usr/bin/env node

import { readFileSync, existsSync } from 'node:fs'
import { appendFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const BOT_MARKER = 'bean-bot:preview'
const BOT_TAG = '@bean-bot'
const ALLOWED_DOC_PATHS = ['README.md', 'docs/']
const UPDATE_FILE = 'docs/pr-updates.md'

function fail(message) {
  console.error(message)
  process.exit(1)
}

function env(name) {
  const value = process.env[name]
  if (!value) fail(`Missing required env: ${name}`)
  return value
}

function parseCommand(body) {
  const text = String(body || '').trim()
  const updateMatch = text.match(/@bean-bot\s+update\s+docs(?:\s+([\s\S]+))?$/i)
  if (updateMatch) {
    return {
      type: 'preview',
      intent: (updateMatch[1] || '').trim(),
    }
  }

  const applyMatch = text.match(/@bean-bot\s+apply\s+([A-Za-z0-9_-]+)$/i)
  if (applyMatch) {
    return {
      type: 'apply',
      token: applyMatch[1],
    }
  }

  return null
}

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }
}

async function ghFetchJson(url, token, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: {
      ...ghHeaders(token),
      ...(init.headers || {}),
    },
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`GitHub API ${res.status} for ${url}: ${body}`)
  }

  return res.json()
}

async function postIssueComment({ owner, repo, issueNumber, token, body }) {
  const url = `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments`
  await ghFetchJson(url, token, {
    method: 'POST',
    body: JSON.stringify({ body }),
    headers: {
      'Content-Type': 'application/json',
    },
  })
}

async function getRepoPermission({ owner, repo, username, token }) {
  const url = `https://api.github.com/repos/${owner}/${repo}/collaborators/${username}/permission`
  const data = await ghFetchJson(url, token)
  return data.permission || 'none'
}

async function getPull({ owner, repo, number, token }) {
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`
  return ghFetchJson(url, token)
}

async function getPullFiles({ owner, repo, number, token }) {
  const files = []
  let page = 1
  while (true) {
    const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${number}/files?per_page=100&page=${page}`
    const chunk = await ghFetchJson(url, token)
    files.push(...chunk)
    if (!Array.isArray(chunk) || chunk.length < 100) break
    page += 1
  }
  return files
}

async function getIssueComments({ owner, repo, issueNumber, token }) {
  const url = `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100`
  return ghFetchJson(url, token)
}

function isAuthorized(permission) {
  return permission === 'write' || permission === 'maintain' || permission === 'admin'
}

function docsScopeSummary(files) {
  const changed = files.map((f) => f.filename)
  const inScope = changed.filter((p) => p === 'README.md' || p.startsWith('docs/'))
  const appHints = changed
    .filter((p) => p.startsWith('src/apps/'))
    .map((p) => p.split('/').pop())

  const hints = []
  if (appHints.length) {
    const unique = [...new Set(appHints)]
    hints.push(`Application changes detected: ${unique.join(', ')}`)
  }

  if (!inScope.length) {
    hints.push('No docs files changed yet. A summary entry can still be added under docs/.')
  }

  return { changed, inScope, hints }
}

function renderEntry({ prNumber, title, url, actor, intent, files }) {
  const day = new Date().toISOString().slice(0, 10)
  const lines = []
  lines.push(`## PR #${prNumber} - ${title}`)
  lines.push('')
  lines.push(`- Date: ${day}`)
  lines.push(`- PR: ${url}`)
  lines.push(`- Requested by: @${actor}`)
  if (intent) lines.push(`- Intent: ${intent}`)
  lines.push('')
  lines.push('### Proposed documentation updates')
  lines.push('- Add this PR summary entry for release tracking.')

  if (files.length) {
    lines.push('- Source areas touched in this PR:')
    for (const f of files.slice(0, 12)) lines.push(`  - ${f}`)
    if (files.length > 12) lines.push(`  - ...and ${files.length - 12} more files`)
  }

  lines.push('')
  return `${lines.join('\n')}\n`
}

function toBase64(text) {
  return Buffer.from(text, 'utf8').toString('base64url')
}

function fromBase64(text) {
  return Buffer.from(text, 'base64url').toString('utf8')
}

function renderPreviewComment({ actor, token, prNumber, headSha, entry, scope }) {
  const preview = entry
    .split('\n')
    .map((line) => `+${line}`)
    .join('\n')

  const meta = toBase64(
    JSON.stringify({
      token,
      prNumber,
      headSha,
      actor,
      file: UPDATE_FILE,
      entry,
      createdAt: new Date().toISOString(),
    }),
  )

  const scopeLine = scope.inScope.length
    ? `In-scope docs files already changed: ${scope.inScope.join(', ')}`
    : 'No in-scope docs files changed yet in this PR.'

  return [
    `@${actor} preview ready for ${BOT_TAG} update docs.`,
    '',
    scopeLine,
    ...scope.hints,
    '',
    '```diff',
    `+++ ${UPDATE_FILE}`,
    preview,
    '```',
    '',
    `To apply: ${BOT_TAG} apply ${token}`,
    '',
    `<!-- ${BOT_MARKER} ${meta} -->`,
  ].join('\n')
}

function findPreview(comments, requestedToken) {
  for (let i = comments.length - 1; i >= 0; i -= 1) {
    const body = comments[i]?.body || ''
    const marker = `<!-- ${BOT_MARKER} `
    const start = body.indexOf(marker)
    if (start < 0) continue

    const end = body.indexOf('-->', start)
    if (end < 0) continue

    const encoded = body.slice(start + marker.length, end).trim()
    if (!encoded) continue

    try {
      const parsed = JSON.parse(fromBase64(encoded))
      if (parsed.token === requestedToken) return parsed
    } catch {
      // Ignore malformed metadata from older runs.
    }
  }
  return null
}

function ensureUpdateFile() {
  if (!existsSync(UPDATE_FILE)) {
    const header = '# PR Documentation Updates\n\n'
    appendFileSync(UPDATE_FILE, header, 'utf8')
  }
}

function appendEntryToDocs(entry, token) {
  ensureUpdateFile()
  const taggedEntry = `${entry.trimEnd()}\n\n<!-- bean-bot-applied:${token} -->\n\n`
  appendFileSync(UPDATE_FILE, taggedEntry, 'utf8')
}

function hasAppliedToken(token) {
  if (!existsSync(UPDATE_FILE)) return false
  const content = readFileSync(UPDATE_FILE, 'utf8')
  return content.includes(`bean-bot-applied:${token}`)
}

function git(args) {
  execFileSync('git', args, { stdio: 'pipe' })
}

function commitAndPush({ branch, token }) {
  git(['config', 'user.name', 'bean-bot'])
  git(['config', 'user.email', 'bean-bot@users.noreply.github.com'])
  git(['add', UPDATE_FILE])

  try {
    git(['diff', '--cached', '--quiet'])
    return false
  } catch {
    // diff --quiet exits non-zero when changes exist.
  }

  git(['commit', '-m', `docs: add PR update summary (${token})`])
  git(['push', 'origin', `HEAD:${branch}`])
  return true
}

async function main() {
  const token = env('GITHUB_TOKEN')
  const eventPath = env('GITHUB_EVENT_PATH')
  const repoFull = env('GITHUB_REPOSITORY')
  const [owner, repo] = repoFull.split('/')

  const event = JSON.parse(readFileSync(eventPath, 'utf8'))
  const issueNumber = event?.issue?.number
  const body = event?.comment?.body || ''
  const actor = event?.comment?.user?.login

  if (!issueNumber || !actor) fail('Missing issue number or actor in event payload')

  const command = parseCommand(body)
  if (!command) {
    await postIssueComment({
      owner,
      repo,
      issueNumber,
      token,
      body: [
        `@${actor} command not recognized.`,
        '',
        `Use ${BOT_TAG} update docs [optional intent]`,
        `or ${BOT_TAG} apply <token>.`,
      ].join('\n'),
    })
    return
  }

  const permission = await getRepoPermission({ owner, repo, username: actor, token })
  if (!isAuthorized(permission)) {
    await postIssueComment({
      owner,
      repo,
      issueNumber,
      token,
      body: `@${actor} only collaborators with write access can use ${BOT_TAG}.`,
    })
    return
  }

  const pull = await getPull({ owner, repo, number: issueNumber, token })

  if (command.type === 'preview') {
    const files = await getPullFiles({ owner, repo, number: issueNumber, token })
    const scope = docsScopeSummary(files)
    const entry = renderEntry({
      prNumber: issueNumber,
      title: pull.title,
      url: pull.html_url,
      actor,
      intent: command.intent,
      files: scope.changed,
    })

    const previewToken = randomUUID().replaceAll('-', '').slice(0, 16)
    const comment = renderPreviewComment({
      actor,
      token: previewToken,
      prNumber: issueNumber,
      headSha: pull.head.sha,
      entry,
      scope,
    })

    await postIssueComment({ owner, repo, issueNumber, token, body: comment })
    return
  }

  if (command.type === 'apply') {
    const comments = await getIssueComments({ owner, repo, issueNumber, token })
    const preview = findPreview(comments, command.token)

    if (!preview) {
      await postIssueComment({
        owner,
        repo,
        issueNumber,
        token,
        body: `@${actor} apply token not found. Run ${BOT_TAG} update docs first.`,
      })
      return
    }

    if (preview.actor !== actor) {
      await postIssueComment({
        owner,
        repo,
        issueNumber,
        token,
        body: `@${actor} this token belongs to @${preview.actor}. Request a new preview token.`,
      })
      return
    }

    const latestPull = await getPull({ owner, repo, number: issueNumber, token })
    if (latestPull.head.sha !== preview.headSha) {
      await postIssueComment({
        owner,
        repo,
        issueNumber,
        token,
        body: `@${actor} PR head changed since preview. Run ${BOT_TAG} update docs again.`,
      })
      return
    }

    const headRepo = latestPull.head.repo.full_name
    const headBranch = latestPull.head.ref
    const sameRepo = headRepo === `${owner}/${repo}`

    if (hasAppliedToken(command.token)) {
      await postIssueComment({
        owner,
        repo,
        issueNumber,
        token,
        body: `@${actor} token ${command.token} was already applied.`,
      })
      return
    }

    if (!ALLOWED_DOC_PATHS.some((p) => UPDATE_FILE === p || UPDATE_FILE.startsWith(p))) {
      fail(`Refusing to edit out-of-scope path: ${UPDATE_FILE}`)
    }

    appendEntryToDocs(preview.entry, command.token)

    if (!sameRepo) {
      await postIssueComment({
        owner,
        repo,
        issueNumber,
        token,
        body: [
          `@${actor} preview applied locally but this PR comes from a fork (${headRepo}).`,
          'I cannot safely push to the fork branch with this token.',
          '',
          `Patch target: ${UPDATE_FILE}`,
          'Please apply manually or re-run from a same-repo branch.',
        ].join('\n'),
      })
      return
    }

    try {
      const pushed = commitAndPush({ branch: headBranch, token: command.token })
      await postIssueComment({
        owner,
        repo,
        issueNumber,
        token,
        body: pushed
          ? `@${actor} docs update committed to ${headBranch}: ${UPDATE_FILE}`
          : `@${actor} no changes to commit for token ${command.token}.`,
      })
    } catch (error) {
      await postIssueComment({
        owner,
        repo,
        issueNumber,
        token,
        body: [
          `@${actor} could not push docs update automatically.`,
          '',
          `Branch: ${headBranch}`,
          `Target: ${UPDATE_FILE}`,
          `Error: ${String(error.message || error)}`,
        ].join('\n'),
      })
      throw error
    }
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})