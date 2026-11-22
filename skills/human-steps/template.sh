#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077

# Fixed helper library. Customize only below the STAGES marker.
_HS_STAGE=0
_HS_WRITES=''
_HS_TEMP=''
_HS_TTY_MODE=''

say() {
    printf '%s\n' "$*"
}

step() {
    printf '  - %s\n' "$*"
}

_hs_finish() {
    _HS_STATUS=$?
    trap - EXIT
    if [ -n "$_HS_TTY_MODE" ]; then
        stty "$_HS_TTY_MODE" 2>/dev/null || :
    fi
    if [ -n "$_HS_TEMP" ]; then
        rm -f "$_HS_TEMP" || :
    fi
    printf '\nWritten locations:\n'
    if [ -n "$_HS_WRITES" ]; then
        printf '%s' "$_HS_WRITES"
    else
        say '  None.'
    fi
    exit "$_HS_STATUS"
}

trap _hs_finish EXIT
trap 'printf "\nStopped by Ctrl-C.\n" >&2; exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

_hs_identifier() {
    case $1 in
        ''|[0-9]*|*[!a-zA-Z0-9_]*|_hs_*|_HS_*)
            say 'Use a shell identifier outside the reserved _hs_ prefix.' >&2
            return 1
            ;;
    esac
}

_hs_record() {
    printf -v _HS_WRITES '%s  %s -> %s\n' "$_HS_WRITES" "$1" "$2"
}

stage() {
    case ${TOTAL:-} in
        ''|0|*[!0-9]*) say 'Set TOTAL to the positive stage count.' >&2; return 1 ;;
    esac
    if [ "$_HS_STAGE" -ge "$TOTAL" ]; then
        say 'Increase TOTAL to match the stages.' >&2
        return 1
    fi
    _HS_STAGE=$((_HS_STAGE + 1))
    if [ -t 1 ]; then
        printf '\033[2J\033[H'
    fi
    printf 'Stage %s of %s: %s\n\n' "$_HS_STAGE" "$TOTAL" "$1"
}

open_url() {
    local _hs_url=$1 _hs_wsl=0
    case $(uname -s) in
        Darwin)
            if command -v open >/dev/null 2>&1 && open "$_hs_url" >/dev/null 2>&1; then
                return 0
            fi
            ;;
        Linux)
            case $(uname -r) in *[Mm]icrosoft*|*WSL*) _hs_wsl=1 ;; esac
            if [ -n "${WSL_DISTRO_NAME:-}${WSL_INTEROP:-}" ]; then
                _hs_wsl=1
            fi
            if [ "$_hs_wsl" -eq 1 ]; then
                if command -v wslview >/dev/null 2>&1 && wslview "$_hs_url" >/dev/null 2>&1; then
                    return 0
                fi
                if command -v cmd.exe >/dev/null 2>&1 && cmd.exe /c start '' "$_hs_url" >/dev/null 2>&1; then
                    return 0
                fi
            elif command -v xdg-open >/dev/null 2>&1 && xdg-open "$_hs_url" >/dev/null 2>&1; then
                return 0
            fi
            ;;
    esac
    say "Open this URL: $_hs_url"
}

ask() {
    _hs_identifier "$1" || return 1
    local _hs_answer
    printf '%s: ' "$2" >&2
    if ! IFS= read -r _hs_answer; then
        printf '\nInput ended.\n' >&2
        return 1
    fi
    printf -v "$1" '%s' "$_hs_answer"
}

ask_secret() {
    _hs_identifier "$1" || return 1
    local _hs_answer _hs_read_status=0
    if [ -t 0 ]; then
        _HS_TTY_MODE=$(stty -g)
    fi
    printf '%s: ' "$2" >&2
    IFS= read -r -s _hs_answer || _hs_read_status=$?
    printf '\n' >&2
    if [ -n "$_HS_TTY_MODE" ]; then
        stty "$_HS_TTY_MODE"
        _HS_TTY_MODE=''
    fi
    if [ "$_hs_read_status" -ne 0 ]; then
        say 'Input ended.' >&2
        return 1
    fi
    printf -v "$1" '%s' "$_hs_answer"
}

write_env() {
    _hs_identifier "$1" || return 1
    local _hs_key=$1 _hs_value=$2 _hs_file=${3:-.env} _hs_line _hs_left _hs_rest _hs_q _hs_tail
    case $_hs_value in
        *$'\n'*|*$'\r'*) say 'Use a single-line value for an env entry.' >&2; return 1 ;;
        *"'"*) say "Values are written single-quoted, so they cannot contain a single quote." >&2; return 1 ;;
    esac
    case $_hs_file in /*|./*|../*) ;; *) _hs_file=./$_hs_file ;; esac
    if [ -L "$_hs_file" ] || { [ -e "$_hs_file" ] && [ ! -f "$_hs_file" ]; }; then
        say 'Choose a regular env file rather than a link or directory.' >&2
        return 1
    fi
    mkdir -p "$(dirname "$_hs_file")" || return 1
    _HS_TEMP=$(mktemp "${_hs_file}.tmp.XXXXXX") || return 1
    chmod 600 "$_HS_TEMP" || return 1
    if [ -f "$_hs_file" ]; then
        while IFS= read -r _hs_line || [ -n "$_hs_line" ]; do
            case $_hs_line in
                *=*)
                    _hs_left=${_hs_line%%=*}
                    _hs_left=${_hs_left#"${_hs_left%%[![:space:]]*}"}
                    case $_hs_left in
                        export[[:space:]]*)
                            _hs_left=${_hs_left#export}
                            _hs_left=${_hs_left#"${_hs_left%%[![:space:]]*}"}
                            ;;
                    esac
                    _hs_left=${_hs_left%"${_hs_left##*[![:space:]]}"}
                    _hs_rest=${_hs_line#*=}
                    _hs_rest=${_hs_rest#"${_hs_rest%%[![:space:]]*}"}
                    _hs_rest=${_hs_rest%"${_hs_rest##*[![:space:]]}"}
                    # Any quoted value whose quote does not close on its line spans several lines, and its inner
                    # lines could look like our key: editing such a file line by line could corrupt it.
                    # A trailing comment after the closing quote is fine.
                    case $_hs_rest in
                        \"*|\'*)
                            _hs_q=${_hs_rest%"${_hs_rest#?}"}
                            _hs_tail=${_hs_rest#?}
                            # Inside double quotes \" is an escaped quote, not the closing one.
                            [ "$_hs_q" = '"' ] && _hs_tail=${_hs_tail//\\\"/}
                            case $_hs_tail in
                                *"$_hs_q"*) ;;
                                *)
                                    rm -f "$_HS_TEMP"; _HS_TEMP=''
                                    say "$_hs_file has a value spanning several lines (${_hs_left}). Add $_hs_key by hand." >&2
                                    return 1
                                    ;;
                            esac
                            ;;
                    esac
                    [ "$_hs_left" = "$_hs_key" ] && continue
                    ;;
            esac
            printf '%s\n' "$_hs_line" >>"$_HS_TEMP" || return 1
        done <"$_hs_file"
    fi
    # Single quotes are literal in Node dotenv and Docker Compose. python-dotenv still expands ${VAR}: see SKILL.md.
    printf "%s='%s'\n" "$_hs_key" "$_hs_value" >>"$_HS_TEMP" || return 1
    mv -f "$_HS_TEMP" "$_hs_file" || return 1
    _HS_TEMP=''
    _hs_record "$_hs_key" "$_hs_file"
}

set_secret() {
    _hs_identifier "$1" || return 1
    local _hs_name=$1 _hs_value=$2 _hs_target='GitHub Actions secret (current repository)'
    shift 2
    [ $# -eq 0 ] || _hs_target="GitHub Actions secret ($*)"
    if printf '%s' "$_hs_value" | gh secret set "$_hs_name" "$@" >/dev/null 2>&1; then
        _hs_record "$_hs_name" "$_hs_target"
    else
        say "Could not set GitHub secret $_hs_name. Check gh sign-in and the repository." >&2
        return 1
    fi
}

set_var() {
    _hs_identifier "$1" || return 1
    local _hs_name=$1 _hs_value=$2 _hs_target='GitHub Actions variable (current repository)'
    shift 2
    [ $# -eq 0 ] || _hs_target="GitHub Actions variable ($*)"
    if printf '%s' "$_hs_value" | gh variable set "$_hs_name" "$@" >/dev/null 2>&1; then
        _hs_record "$_hs_name" "$_hs_target"
    else
        say "Could not set GitHub variable $_hs_name. Check gh sign-in and the repository." >&2
        return 1
    fi
}

confirm() {
    local _hs_answer
    printf '%s [y/N]: ' "$1" >&2
    IFS= read -r _hs_answer || return 1
    case $_hs_answer in y|Y|yes|YES|Yes) return 0 ;; *) return 1 ;; esac
}

pause() {
    local _hs_pause
    printf 'Press Enter to continue. ' >&2
    IFS= read -r _hs_pause
}

# ---- STAGES ----
# Replace this demonstration with the confirmed stages and count.
TOTAL=1
stage 'Save an example API key'
say 'Use a made-up key for this demonstration.'
open_url 'https://example.com'
step 'Return to this terminal after the page opens.'
EXAMPLE_API_KEY=''
ask_secret EXAMPLE_API_KEY 'Paste the example key'
if confirm 'Save the example key in .env?'; then
    write_env EXAMPLE_API_KEY "$EXAMPLE_API_KEY"
fi
unset EXAMPLE_API_KEY
pause
