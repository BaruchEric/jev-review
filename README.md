# Jev Review

A small code-review workflow built with [TypeSafe Jev](https://typesafe.ai). It turns a Git diff into structured review signals, follows the strongest ones through focused model calls, and presents the result in a quiet local dashboard.

![Jev Review dashboard](docs/dashboard.png)

## How It Works

The reviewer keeps orchestration in code and uses Jev for bounded judgments:

```text
Noul risk matrix
  -> Choice + Score file profiles
  -> Choice evidence selection
  -> Choice mechanism classification
  -> Score severity
  -> conditional Choice reviewer routing
```

- Reviews changed JavaScript and TypeScript files from the current Git diff.
- Uses changed tests as cross-file context when judging test gaps.
- Screens correctness, security, reliability, compatibility, and test coverage.
- Selects concrete hunks before scoring impact.
- Applies thresholds and workflow policy in code.
- Binds the dashboard to `127.0.0.1` and never serves environment files.

## Quick Start

Requires Node.js 24+, Git, and a [TypeSafe API key](https://console.typesafe.ai/settings/keys).

```bash
npm install
cp .env.example .env
# Add TYPESAFE_API_KEY to .env

npm run review:save -- /path/to/git/repository
npm run dashboard
```

Open [http://127.0.0.1:4317](http://127.0.0.1:4317).

## Commands

| Command | Purpose |
| --- | --- |
| `npm run review -- <path>` | Print a review report as JSON |
| `npm run review:save -- <path>` | Save the latest report for the dashboard |
| `npm run dashboard` | Start the local dashboard |
| `npm run check` | Run syntax checks |

## Current Scope

This is an experiment in composing fast typed judgments into a review workflow. It does not yet integrate compiler diagnostics, static analyzers, repository indexing, or generated explanations. Findings are review prompts, not proof of a defect.

## License

[MIT](LICENSE)
