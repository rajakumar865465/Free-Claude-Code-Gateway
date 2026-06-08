# Contributing to Free Claude Code Gateway

Thanks for your interest in contributing. This is a focused project — keep changes small, targeted, and well-tested.

---

## Before You Start

- Check [open issues](https://github.com/rajakumar865465/Free-Claude-Code-Gateway/issues) to avoid duplicate work.
- For bug fixes, open an issue first describing the problem.
- For new features, open a feature request issue and wait for a thumbs-up before implementing.

---

## Development Setup

```bash
git clone https://github.com/rajakumar865465/Free-Claude-Code-Gateway.git
cd Free-Claude-Code-Gateway
npm install
cp .env.example .env
# Edit .env with your provider key and base URL
npm run dev
```

---

## Code Standards

- **TypeScript strict mode** — no `any` unless absolutely necessary.
- **No comments** in source code unless complex logic requires explanation.
- **Pino for all logging** — never use `console.log` in production paths.
- **Redact sensitive fields** — always use `src/utils/redact.ts` helpers before logging.
- **Error mapping** — upstream errors must be converted to Anthropic error format via `src/converters/errors.ts`.

---

## Before Opening a PR

Run these in order and make sure all pass:

```bash
npm run typecheck   # TypeScript must be clean
npm test            # All tests must pass
npm run build       # Build must succeed
```

---

## Adding a New Provider

The gateway is provider-agnostic — it only needs an OpenAI-compatible base URL. You don't need to add provider-specific code. Just point `BLUESMINDS_BASE_URL` at the provider and update `config/models.json`.

---

## Pull Request Guidelines

- Keep PRs focused — one feature or fix per PR.
- Include a clear description of what changed and why.
- Reference the issue number in the PR description.
- Don't open Docker integration PRs.
- Don't open README-only PRs — open an issue instead.

---

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
