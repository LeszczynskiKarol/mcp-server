# Contributing

Thanks for considering contributing! This is a small project and pull requests are welcome.

## Reporting bugs

Open an issue using the **Bug report** template with:
- What you tried to do
- What happened instead
- Your environment (OS, Node version, MCP client — Claude.ai / Claude Desktop / custom)
- Relevant logs from `pm2 logs mcp --lines 50 --nostream` or `node server.js` output
- **Redact secrets** before pasting logs (OAuth tokens, GitHub PATs, passwords)

## Suggesting features

Open an issue using the **Feature request** template. Tell us the use case — a concrete
real-world example is much more useful than an abstract description.

## Adding a new tool

1. Fork the repo and create a feature branch.
2. Add your tool to `server.js`:

```javascript
   server.tool(
     "your_tool_name",
     "Clear description of when Claude should use this tool",
     {
       param: z.string().describe("what this parameter does"),
     },
     async ({ param }) => {
       // your logic
       return { content: [{ type: "text", text: "result" }] };
     },
   );
```

3. Test locally with `node server.js`, then disconnect/connect the connector in your
   MCP client and verify the new tool appears.
4. Open a PR with a description of what the tool does and an example invocation.

## Code style

- Keep tools small and composable. One tool = one job.
- Validate every input with Zod. Use `.describe()` so Claude knows when to use the tool
  and what to pass.
- Use `try/catch` and return `{ content: [...], isError: true }` on failure. Don't crash
  the whole server because one tool call failed.
- Never log sensitive data: OAuth tokens, GitHub PATs, raw request bodies that may
  contain PII, or full error objects from auth libraries (they sometimes embed token
  fragments in stack traces).
- Use ES modules (`import`, not `require`). `package.json` has `"type": "module"`.

## Security

If you find a security vulnerability, **do not open a public issue**. Email the
maintainer (see `package.json` `author` field) so the issue can be fixed before
disclosure.

## License

By contributing, you agree that your contributions will be licensed under the MIT
License (see `LICENSE`).
