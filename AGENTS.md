# Repository guidelines

## Code style

- Use braces for conditionals and loops, including single-statement bodies.
- Put conditional bodies on separate lines, including single-statement bodies.
- Separate distinct steps with one blank line. Give validation, state updates,
  and the final return their own visual space. Keep closely related statements
  together.
- Initialize variables at declaration. Keep intermediate values when they
  clarify the logic.
- Use an explicit `else` when two alternatives read more clearly together.
- Group exception handling around operations that share the same recovery or
  cleanup.
- Use line comments (`//`) for single-line comments.
- Write short English comments for non-obvious rules. Finish with
  `npm run lint:fix`.

## Commits

- Follow [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/).
- Allowed types: `feat`, `fix`, `build`, `chore`, `ci`, `docs`, `style`,
  `refactor`, `perf`, `test`, `revert`.
- Use a single-line message for non-breaking changes. For breaking changes,
  add `!` to the subject and explain the break in a `BREAKING CHANGE:` footer.
- Before each commit, verify that `README.md` is up to date and update it if
  needed.
- Before each commit, check for missing `CHANGELOG.md` updates or missing
  version bumps required by SemVer.

## Branches

Follow [GitHub Flow](https://docs.github.com/en/get-started/using-github/github-flow).
Branch from `main`. If you can push directly to `main`, prefer a local squash
merge followed by a push. If direct pushes are blocked, open a pull request and
squash merge after review and required checks. Delete the topic branch after
merging. Squashing keeps `main`'s history focused on the final change.

## Versions

Follow [SemVer 2.0.0](https://semver.org/). For breaking changes before
`1.0.0`, bump MINOR and keep MAJOR at zero.

## Changelog

Follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Record notable
changes in `CHANGELOG.md` under `[Unreleased]` and the relevant change category.
At release, move the entries to `## [version] - YYYY-MM-DD`.
