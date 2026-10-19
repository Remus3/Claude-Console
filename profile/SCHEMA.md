# Setup profile schema (version 1)

The setup profile is data: one `profile.json` manifest and one `module.json` per module,
plus text templates. `installer/profile-schema.js` validates all of it; the engine refuses
a profile that does not validate. Tests: `tests/profile-schema.test.js` against the fixture
`tests/fixtures/profile-min/`.

Every validator call returns `{ok, errors}`; each error is `{path, msg}` with a path such
as `modules/session/module.json.items[0].contributes[1].target`. The validator reads files,
never writes, and never throws on bad input. Unknown keys are errors everywhere.

## Layout

```
profile/
  profile.json
  modules/<module-id>/module.json
  modules/<module-id>/templates/...
```

Every module listed in `profile.json` has its directory; a module directory that is not
listed is an error. A module's `id` equals its directory name and its `order` equals its
1-based position in the `modules` list.

## profile.json

| Key | Rule |
|---|---|
| `schema` | `1` |
| `profile` | lower-case id (`^[a-z][a-z0-9-]*$`) |
| `version`, `console_min` | `x.y.z` (an optional `-suffix` is allowed) |
| `kit_source_version` | integer >= 1: the kit version the bundled kit was built from |
| `modules` | non-empty array of unique module ids, in order |
| `presets` | optional; name (lower-case id) -> array of listed module ids, or `"*"` for all |
| `variables` | name (`^[a-z][a-z0-9_]*$`) -> variable object |

### Variables

Keys: `type`, `pattern`, `ask`, `why`, `scope`, `default`, `detect`, `optional`, `secret`,
`store`, `value`, `min`, `max`, `measure`.

Types: `code`, `path`, `relpath`, `derived`, `exe`, `url`, `git-ident`, `int`, `object`,
`ssh-alias`, `string`, `bool`.

- `pattern` must compile as a regular expression.
- `derived` has a `value` template (other variables in braces), never a `default`, and
  never refers to itself; no other type has a `value`.
- A `default` is never machine-specific: no drive path, no user home, no loopback
  address with a port, no email. Use a variable such as `{documents}` instead.
- `relpath` defaults are relative, forward-slash and without `..`.
- `int` defaults are integers inside `min`/`max`.
- A `measure` variable has no fixed default: the engine proposes a value from the
  measurement (measure before choosing a threshold).
- A `secret` variable has no default.
- `scope` is `target` or `user`; `store` is `git-config-local` or `secret-store`.

Built-in placeholders, always available: `{documents}`, `{home}`, `{temp}`, `{data_dir}`.
A reference is `{name}`; `${name}` (shell syntax) is not a reference.

## module.json

| Key | Rule |
|---|---|
| `schema` | `1` |
| `id` | lower-case id, equal to the directory name |
| `order` | integer 1..99, the module's position |
| `title`, `summary`, `why` | non-empty text |
| `default` | `on` or `off` |
| `locked` | optional boolean; a locked module is `on` and so is each of its items |
| `items` | 1..99 items |

### Items

Keys: `id`, `order`, `title`, `does`, `why`, `risk`, `default`, `platform`, `depends_on`,
`pairs_with`, `conflicts_with`, `contributes`, `detect`, `verify`, `scope`, `notes`.

- `id`: lower-case id, unique across the whole profile.
- `order` = module order x 100 + 1-based position in `items` (module 3, first item: 301).
- `title`, `does`, `why` (and `notes` when present): non-empty text with no literal path,
  email, uuid, artifact URL or loopback port; variables in braces must be declared.
- `risk`: `low`, `medium` or `high`. `default`: `on` or `off`.
- `platform`: non-empty subset of `win32`, `darwin`, `linux`.
- `scope`: optional, `generic`, `machine-specific` or `template`. Private items never
  ship, so `private` is refused.
- `depends_on`, `pairs_with`, `conflicts_with`: arrays of item ids that exist in the
  profile; never the item itself; `conflicts_with` is symmetric; an id is never both a
  dependency and a conflict; dependencies have no cycle.
- An item with an `env` or `task` contribution is `high` risk and `["win32"]` only; an
  item with a `.ps1` template is `["win32"]` only.

### Contributions (closed list)

| kind | Keys | Rules |
|---|---|---|
| `file` | `target`, `template`, `mode` | `mode` is `create-only`, `managed` or `replace-ask` |
| `block` | `target`, `block`, `template`, `slot` | `block` is a lower-case id; `slot` an integer >= 0 |
| `json-merge` | `target`, `template` or `value`, `mode` | target is `repo:.claude/settings.json`, `repo:.claude/settings.local.json` or `user:settings.json`; exactly one of `template`, `value` (an object); `mode` is `add` or `replace-ask` |
| `env` | `name`, `value` or `secret`, `scope` | upper-case name; exactly one of `value`, `secret` (a reference name); a value that looks like a key is refused; `scope` is `user` |
| `task` | `name`, `template` | name starts `ClaudeProfile-`; the template is the task XML |
| `git` | `key`, `value`, `scope` | `section.name` key; `scope` is `local` |
| `kit` | `files`, `target` | non-empty list of plain kit file names |
| `app-config` | `target` (`{file, key}`), `to`, `format`, `processes` | one EXISTING key of an app config file (addendum a.3); `to` is one string, number or boolean of the same type; `format` is `ini`, `json`, `xml` or `vdf` (else by extension); `processes` are the owning image names, and the edit is refused while one runs |

A `target` is `repo:<path>` (inside the target repo) or `user:<path>` (inside the Claude
config dir): relative, forward-slash, no `..`, no wildcard, variables declared. A
`template` path is relative to the module directory and lies under `templates/`.

### Detect and verify

`detect` entries (adopt scan), exactly one kind each: `{"file": target}` (wildcards
allowed), `{"text": target, "regex": re}`, `{"json": target, "key": k}`, `{"env": NAME}`,
`{"git": key}`.

`verify` entries (read-back after apply), exactly one kind each: `file-ascii-lf`,
`regex` (with exactly one of `line1`, `match`), `json-parse`, `hook-smoke`,
`env-readback`, `task-readback`, `git-hooks`, `budget`.

## Templates

Every template a contribution names must exist. Templates are ASCII and LF only, every
`{name}` is a declared or built-in variable, and no line carries a literal path, email,
uuid, artifact URL or loopback port.
