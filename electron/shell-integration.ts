import fs from "node:fs";
import path from "node:path";

/**
 * Keeps Tacit's command folders first on PATH in a shell terminal, after the
 * person's own startup files have run.
 *
 * Tacit puts two folders on a shell terminal's PATH: the `tacit` CLI, and the
 * agent shims that give `claude` / `codex` typed at the prompt their
 * workspace tools. It used to prepend them to the environment and start the
 * shell as a login shell. But a login shell runs its startup files after
 * that — macOS's /etc/zprofile reorders PATH with path_helper, and a
 * ~/.zprofile or ~/.zshrc typically prepends ~/.local/bin, where the real
 * `claude` lives. The shims ended up behind the binaries they wrap, so typing
 * `claude` ran the real one and the agent got no tools, silently.
 *
 * So the shell is pointed at a small set of Tacit startup files instead. Each
 * one loads the person's own file of the same name, unchanged, and only then
 * puts Tacit's folders back in front — and again before every prompt, since
 * tools like direnv or mise rewrite PATH later. The person's files are never
 * edited. This is what VS Code's terminal does for the same reason.
 *
 * Supported: zsh (ZDOTDIR), bash (--rcfile), fish (--init-command). Any other
 * shell keeps the old behaviour: prepended before startup, which its startup
 * files may undo.
 */

export type IntegratedShell = "zsh" | "bash" | "fish";

export function integratedShellKind(shellPath: string): IntegratedShell | null {
  const name = path.basename(shellPath).replace(/^-/, "");
  if (name === "zsh" || name === "bash" || name === "fish") return name;
  return null;
}

/** Colon-separated folders to keep first, in order. */
export const PATH_FIRST_ENV = "TACIT_PATH_FIRST";
/** Where the person's own zsh startup files live. */
export const USER_ZDOTDIR_ENV = "TACIT_USER_ZDOTDIR";

const ZSH_HEADER = `# Tacit shell integration. Loads your own startup file of the same name,
# unchanged, from $${USER_ZDOTDIR_ENV}. Generated — edits are overwritten.
`;

/**
 * Sources the person's copy of one zsh startup file with ZDOTDIR set to their
 * directory, so anything inside it that reads ZDOTDIR sees their own. If their
 * file moves ZDOTDIR (a .zshenv relocating config is common), that becomes
 * where the next file is read from.
 */
function zshSourceUserFile(name: string): string {
  return `_tacit_zdotdir="$ZDOTDIR"
ZDOTDIR="\${${USER_ZDOTDIR_ENV}:-$HOME}"
if [[ -f "$ZDOTDIR/${name}" ]]; then
  source "$ZDOTDIR/${name}"
fi
${USER_ZDOTDIR_ENV}="$ZDOTDIR"
ZDOTDIR="$_tacit_zdotdir"
unset _tacit_zdotdir
`;
}

export function zshStartupFiles(): Record<".zshenv" | ".zprofile" | ".zshrc", string> {
  return {
    ".zshenv": ZSH_HEADER + zshSourceUserFile(".zshenv"),
    ".zprofile": ZSH_HEADER + zshSourceUserFile(".zprofile"),
    ".zshrc":
      ZSH_HEADER +
      `# macOS's /etc/zshrc runs before this file and sets
# HISTFILE=\${ZDOTDIR:-$HOME}/.zsh_history — which, with ZDOTDIR pointed here,
# would quietly move your shell history into Tacit's folder. Put it back.
if [[ "$HISTFILE" == "$ZDOTDIR/.zsh_history" ]]; then
  HISTFILE="\${${USER_ZDOTDIR_ENV}:-$HOME}/.zsh_history"
fi
` +
      zshSourceUserFile(".zshrc") +
      `_tacit_path_first() {
  local dir
  for dir in \${(Oas.:.)${PATH_FIRST_ENV}}; do
    path=("$dir" \${path:#$dir})
  done
}
autoload -Uz add-zsh-hook
add-zsh-hook precmd _tacit_path_first
_tacit_path_first
# From here on this is your shell: .zlogin, and any zsh started inside it,
# read your own directory.
ZDOTDIR="\${${USER_ZDOTDIR_ENV}:-$HOME}"
`,
  };
}

/**
 * Stands in for a bash login shell's startup: /etc/profile, then the first of
 * ~/.bash_profile, ~/.bash_login, ~/.profile — the same order bash uses —
 * then Tacit's folders first. It runs as an interactive shell with this as
 * its rc file, since bash offers no hook after a login shell's files.
 */
export function bashRcFile(): string {
  return `# Tacit shell integration. Loads your own startup files, unchanged, in
# the order a bash login shell would. Generated — edits are overwritten.
if [ -f /etc/profile ]; then . /etc/profile; fi
for _tacit_rc in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
  if [ -f "$_tacit_rc" ]; then . "$_tacit_rc"; break; fi
done
unset _tacit_rc
_tacit_path_first() {
  local dir rest entry
  local IFS=:
  local -a dirs=($${PATH_FIRST_ENV})
  local i
  for (( i=\${#dirs[@]}-1; i>=0; i-- )); do
    dir="\${dirs[i]}"
    rest=""
    for entry in $PATH; do
      [ "$entry" = "$dir" ] || rest="\${rest:+$rest:}$entry"
    done
    PATH="$dir\${rest:+:$rest}"
  done
}
PROMPT_COMMAND="_tacit_path_first\${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
_tacit_path_first
`;
}

/** Runs after fish's own config, and again before every prompt. */
export function fishInitCommand(): string {
  return `function __tacit_path_first --on-event fish_prompt
  for dir in (string split : -- $${PATH_FIRST_ENV})[-1..1]
    set -gx PATH $dir (string match -v -- $dir $PATH)
  end
end
__tacit_path_first`;
}

/**
 * Writes the startup files into `dir`, replacing any older copies.
 *
 * Built in a sibling folder and swapped in whole, because a half-written
 * folder is worse than none: zsh pointed at a folder missing its .zshrc would
 * skip the person's own .zshrc too. Launches only use the folder if it
 * exists, so it must only exist complete.
 */
export function writeShellIntegrationFiles(dir: string): void {
  const staging = `${dir}.tmp-${process.pid}`;
  fs.rmSync(staging, { recursive: true, force: true });
  try {
    fs.mkdirSync(path.join(staging, "zsh"), { recursive: true });
    for (const [name, contents] of Object.entries(zshStartupFiles())) {
      fs.writeFileSync(path.join(staging, "zsh", name), contents, "utf-8");
    }
    fs.mkdirSync(path.join(staging, "bash"), { recursive: true });
    fs.writeFileSync(path.join(staging, "bash", "rc.bash"), bashRcFile(), "utf-8");
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(staging, dir);
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Where the person's zsh files are: an inherited ZDOTDIR if they use one, else
 * home. Never Tacit's own folder — a shell started from inside a Tacit
 * terminal before its startup finished could inherit that, and pointing the
 * files at themselves would make each one source itself forever.
 */
function userZdotdir(env: Record<string, string>, integrationDir: string): string {
  const own = path.join(integrationDir, "zsh");
  const inherited = env.ZDOTDIR;
  if (inherited && path.resolve(inherited) !== path.resolve(own)) return inherited;
  return env.HOME || "";
}

/**
 * How to start this shell so `pathFirst` stays in front: the arguments to use
 * and the environment to add. Null for a shell this does not know.
 */
export function shellIntegrationLaunch(options: {
  shell: string;
  integrationDir: string;
  pathFirst: string[];
  env: Record<string, string>;
}): { args: string[]; env: Record<string, string> } | null {
  const kind = integratedShellKind(options.shell);
  if (!kind) return null;
  const pathFirst = options.pathFirst.join(":");

  switch (kind) {
    case "zsh":
      return {
        args: ["-l"],
        env: {
          [PATH_FIRST_ENV]: pathFirst,
          // Where their own files are: an inherited ZDOTDIR if they use one.
          [USER_ZDOTDIR_ENV]: userZdotdir(options.env, options.integrationDir),
          ZDOTDIR: path.join(options.integrationDir, "zsh"),
        },
      };
    case "bash":
      return {
        args: ["--rcfile", path.join(options.integrationDir, "bash", "rc.bash"), "-i"],
        env: { [PATH_FIRST_ENV]: pathFirst },
      };
    case "fish":
      return {
        args: ["-l", "--init-command", fishInitCommand()],
        env: { [PATH_FIRST_ENV]: pathFirst },
      };
  }
}
