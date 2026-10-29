#!/bin/bash
set -e

cd "$(dirname "$0")" || exit 1
source ../git.sh

[ -n "$GH_TOKEN" ] || { echo "no GH_TOKEN"; exit 1; }
[ -n "$GH_USER" ] || { echo "no GH_USER"; exit 1; }

REPO="github.com/underdebug/2611A-joey.git"
BRANCH="main"
URL="https://${GH_USER}:${GH_TOKEN}@${REPO}"
MSG="${1:-update $(date '+%F %H:%M')}"

# Initialize repository if needed
if [ ! -d .git ]; then
    git init
    git config user.name "$GH_USER"
    git config user.email "mingjie2026@gmail.com"
fi

# Select branch
git symbolic-ref HEAD "refs/heads/$BRANCH"

# Ignore build and Python cache directories
touch .gitignore
for pattern in 'build/' '__pycache__/'; do
    grep -Fxq "$pattern" .gitignore || echo "$pattern" >> .gitignore
done

# Remove previously tracked build/cache files from Git index only
# Keep all local files and directories
remove_ignored_from_index() {
    while IFS= read -r -d '' file; do
        case "/$file/" in
            */build/*|*/__pycache__/*)
                git rm --cached -q -- "$file"
                ;;
        esac
    done < <(git ls-files -z)
}

remove_ignored_from_index

# Stage and commit local changes BEFORE merging
git add -A

if ! git diff --cached --quiet; then
    git commit -m "$MSG"
else
    echo "no local changes"
fi

# Retrieve remote changes
if git fetch "$URL" "$BRANCH"; then
    git merge FETCH_HEAD -X ours --no-edit --allow-unrelated-histories
else
    echo "Fetch failed. Upload canceled."
    exit 1
fi

# Remove tracked build/cache files introduced by remote merge
remove_ignored_from_index

git add -A

if ! git diff --cached --quiet; then
    git commit -m "$MSG cleanup"
fi

# Upload merged changes
git push "$URL" "$BRANCH"

echo "Upload complete."
