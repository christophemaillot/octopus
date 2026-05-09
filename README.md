# Octopus

Monorepo Octopus — desktop client multi-agents pour OpenClaw

## Structure

```
octopus/
├── packages/
│   ├── plugin/     ← OpenClaw plugin (TypeScript)
│   ├── hub/        ← Serveur Rust (pont Helios)
│   └── desktop/    ← Client Tauri (frontend web)
├── Cargo.toml      ← Workspace Rust
└── package.json    ← Workspace npm
```

## Prerequisites

- Rust toolchain
- Node.js 22+
- Tauri CLI
