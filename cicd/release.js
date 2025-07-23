const fs = require('fs');
const {
    versionBump,
    fetchTags,
    updateVersion,
    fetchMergedPRs,
    getBumpType,
    generateChangelog,
    getLastReleaseDateFromGit,
    getLastTag,
    getVersionFromLatestTag,
    getChangelogFromTag,
} = require('./release_utils');

const REPO = process.env.GITHUB_REPOSITORY;
const TOKEN = process.env.GITHUB_TOKEN;
const dryRun = process.argv.includes('--dry-run');
const baseBranch = 'develop'; // or 'main' if you want to track PRs merged into main

if (!REPO || !TOKEN) {
    console.error('Set GITHUB_REPOSITORY and GITHUB_TOKEN env vars');
    process.exit(1);
}

(async () => {
    try {
        console.log(
            dryRun
                ? '🔍 Running in dry-run mode...'
                : '🚀 Running full release...'
        );

        fetchTags();
        const sinceDate = getLastReleaseDateFromGit();
        console.log({ sinceDate });
        const lastTag = getLastTag();
        console.log({ lastTag });
        // Fetch merged PRs into develop branch
        const mergedPRs = await fetchMergedPRs(
            REPO,
            TOKEN,
            baseBranch,
            sinceDate
        );

        if (!mergedPRs.length) {
            console.log('No merged PRs found.');
            process.exit(0);
        }

        // Sort PRs by merge date ascending
        mergedPRs.sort((a, b) => new Date(a.merged_at) - new Date(b.merged_at));

        // Get version from previous release tags
        const currentVersion = getVersionFromLatestTag();

        // Determine bump type (major, minor, patch)
        const bump = getBumpType(mergedPRs);

        // Compute next version manually
        const nextVersion = versionBump(currentVersion, bump);

        console.log(
            `Current version: ${currentVersion}, bump: ${bump}, next version: ${nextVersion}`
        );

        // const groupedPRs = groupPRsByLabel(mergedPRs).groups;
        const count = mergedPRs.length;
        if (count === 0) {
            console.log(`✨ no update changelog Needed`);
            process.exit(0);
        }
        const newChangelog = generateChangelog(nextVersion, mergedPRs);
        const previousChangelog = lastTag ? getChangelogFromTag(lastTag) : '';

        if (previousChangelog.includes(`## ${nextVersion}`)) {
            console.log(
                `⚠️ Changelog for version ${nextVersion} already exists in previous release.`
            );
            process.exit(0);
        }

        if (dryRun) {
            console.log('\n📜 Changelog Preview:\n');
            console.log(newChangelog);
            console.log('\n✅ Dry-run complete. No files were changed.');
        } else {
            // Write changelog to file
            if (fs.existsSync('CHANGELOG.md')) {
                fs.writeFileSync(
                    'CHANGELOG.md',
                    newChangelog + '\n' + previousChangelog
                );
            } else {
                fs.writeFileSync('CHANGELOG.md', newChangelog);
            }

            // Update version in package.json
            updateVersion(nextVersion);

            console.log(
                '✅ Changelog updated and package.json version bumped.'
            );
        }
    } catch (err) {
        console.error('Error:', err);
        process.exit(1);
    }
})();
