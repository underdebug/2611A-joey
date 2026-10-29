
#!/usr/bin/env bash
set -Eeuo pipefail

# Enter the directory containing this script
cd "$(dirname "${BASH_SOURCE[0]}")"

# Load GitHub credentials
source ../git.sh

# Check required credentials
if [[ -z "${GH_TOKEN:-}" ]]; then
    echo "Error: no GH_TOKEN"
    exit 1
fi

if [[ -z "${GH_USER:-}" ]]; then
    echo "Error: no GH_USER"
    exit 1
fi

# GitHub repository
REPO="underdebug/2611A-joey.git"
URL="https://${GH_USER}:${GH_TOKEN}@github.com/${REPO}"

# Commit settings
MSG="${1:-update $(date '+%F %H:%M')}"
GIT_EMAIL="${GH_EMAIL:-mingjie2026@gmail.com}"

# Check repository access and discover remote branches
if ! REMOTE_HEADS="$(git ls-remote --heads "$URL")"; then
    echo "Error: Cannot access GitHub repository."
    echo "Check GH_USER, GH_TOKEN, and repository permissions."
    exit 1
fi

if ! REMOTE_SYMREF="$(git ls-remote --symref "$URL" HEAD)"; then
    echo "Error: Could not determine the remote default branch."
    exit 1
fi

# Read the remote default branch, if available
REMOTE_DEFAULT="$(
    printf '%s\n' "$REMOTE_SYMREF" |
        awk '$1 == "ref:" && $3 == "HEAD" {
            sub("^refs/heads/", "", $2)
            print $2
            exit
        }'
)"

# Check whether a particular branch exists remotely
branch_exists() {
    local wanted="refs/heads/$1"

    awk -v wanted="$wanted" '
        $2 == wanted { found = 1 }
        END { exit !found }
    ' <<< "$REMOTE_HEADS"
}

# Automatically choose the target branch
if [[ -n "$REMOTE_DEFAULT" ]] && branch_exists "$REMOTE_DEFAULT"; then
    BRANCH="$REMOTE_DEFAULT"
elif branch_exists "main"; then
    BRANCH="main"
elif branch_exists "master"; then
    BRANCH="master"
elif [[ -n "$REMOTE_HEADS" ]]; then
    BRANCH="$(
        awk 'NR == 1 {
            sub("^refs/heads/", "", $2)
            print $2
            exit
        }' <<< "$REMOTE_HEADS"
    )"
else
    # Use main if the GitHub repository has no branches yet
    BRANCH="main"
fi

if branch_exists "$BRANCH"; then
    REMOTE_HAS_BRANCH=1
else
    REMOTE_HAS_BRANCH=0
fi

echo "Repository: github.com/$REPO"
echo "Target branch: $BRANCH"

# Initialize Git if needed
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git init
fi

# Configure local commit identity
git config user.name "$GH_USER"
git config user.email "$GIT_EMAIL"

# Set the branch for a repository without any commits
if ! git rev-parse --verify HEAD >/dev/null 2>&1; then
    git symbolic-ref HEAD "refs/heads/$BRANCH"
fi

# Keep build and Python cache directories out of Git
touch .gitignore

for pattern in 'build/' '__pycache__/'; do
    if ! grep -Fqx -- "$pattern" .gitignore; then
        printf '%s\n' "$pattern" >> .gitignore
    fi
done

# Remove tracked build/cache files from the index.
# The files remain on your computer.
remove_ignored_from_index() {
    local file

    while IFS= read -r -d '' file; do
        case "$file" in
            build/*|*/build/*|__pycache__/*|*/__pycache__/*)
                git rm --cached -r -q -f -- "$file"
                ;;
        esac
    done < <(git ls-files -z)
}

remove_ignored_from_index

# Stage and commit local changes
git add -A

if ! git diff --cached --quiet; then
    git commit -m "$MSG"
else
    echo "No local changes"
fi

# Synchronize with the remote branch
if [[ "$REMOTE_HAS_BRANCH" -eq 1 ]]; then
    echo "Fetching remote branch: $BRANCH"

    if ! git fetch "$URL" "$BRANCH"; then
        echo "Error: Fetch failed. Upload canceled."
        exit 1
    fi

    # A freshly initialized local repository may not have a commit yet.
    if ! git rev-parse --verify HEAD >/dev/null 2>&1; then
        echo "Initializing local history from remote..."
        git reset --mixed FETCH_HEAD
    else
        echo "Merging remote changes..."

        git merge FETCH_HEAD \
            -X ours \
            --no-edit \
            --allow-unrelated-histories
    fi
else
    echo "Remote branch '$BRANCH' does not exist yet."
    echo "A new remote branch will be created."
fi

# Remove build/cache files that may have arrived through the merge
remove_ignored_from_index

# Stage any remaining changes
git add -A

# Commit cleanup changes if necessary
if ! git diff --cached --quiet; then
    git commit -m "$MSG cleanup"
fi

# Ensure a commit exists before pushing
if ! git rev-parse --verify HEAD >/dev/null 2>&1; then
    echo "Error: Nothing to push; no Git commit exists."
    exit 1
fi

# Push the current local commit to the selected remote branch.
# The local branch name does not need to match the remote branch name.
echo "Pushing to GitHub..."

git push "$URL" "HEAD:refs/heads/$BRANCH"

echo "Upload complete!"
echo "Repository: https://github.com/underdebug/2611A-joey"
echo "Branch: $BRANCH"

