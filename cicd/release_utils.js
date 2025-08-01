const https = require('https')
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

/**
 * Manually increment a semver string by bump type
 * @param {string} version - e.g. "1.2.3"
 * @param {"major"|"minor"|"patch"} bumpType
 * @returns {string} bumped version
 */
function versionBump(version, bumpType) {
    let [major, minor, patch] = version.split('.').map(Number)
    if (
        isNaN(major) ||
        isNaN(minor) ||
        isNaN(patch) ||
        major < 0 ||
        minor < 0 ||
        patch < 0
    ) {
        major = 0
        minor = 0
        patch = 0
    }
    switch (bumpType) {
        case 'major':
            major++
            minor = 0
            patch = 0
            break
        case 'minor':
            minor++
            patch = 0
            break
        case 'patch':
            patch++
            break
        default:
            throw new Error(`Unknown bump type: ${bumpType}`)
    }
    return `${major}.${minor}.${patch}`
}

/**
 * Read current version from package.json or fallback
 */
function getCurrentVersion() {
    try {
        const pkgPath = path.resolve('package.json')
        if (fs.existsSync(pkgPath)) {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
            if (pkg.version) return pkg.version
        }
    } catch {
        // ignore
    }

    // fallback to version.txt
    try {
        const versionTxt = path.resolve('version.txt')
        if (fs.existsSync(versionTxt)) {
            const v = fs.readFileSync(versionTxt, 'utf8').trim()
            if (v) return v
        }
    } catch {
        // ignore
    }

    return '0.0.0' // default fallback
}

/**
 * Update package.json / version.txt version to newVersion
 */
function updateVersion(newVersion) {
    try {
        const pkgPath = path.resolve('package.json')
        if (fs.existsSync(pkgPath)) {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
            if (pkg.version === newVersion) {
                console.log(`Version is already ${newVersion}, no update needed.`)
                return
            }

            execSync(`npm version ${newVersion} --no-git-tag-version`, { stdio: 'inherit' })
            console.log(`Updated package.json and package-lock.json to version ${newVersion}`)
        }
    } catch {
        // ignore
    }

    // fallback to version.txt
    try {
        const versionTxt = path.resolve('version.txt')
        fs.writeFileSync(versionTxt, newVersion + '\n')
    } catch (err) {
        throw new Error(
            `Failed to update version in package.json or version.txt: ${err.message}`
        )
    }
}

/**
 * Fetch all merged PRs into baseBranch of repo using GitHub API
 * @param {string} repo - "owner/repo"
 * @param {string} token - GitHub token
 * @param {string} baseBranch - e.g. "develop"
 * @param {string} since - ISO date string (e.g. "2023-07-01")
 * @returns {Promise<Array>}
 */
async function fetchMergedPRs(
    repo,
    token,
    baseBranch = 'develop',
    since = '1970-01-01'
) {
    const [owner, repoName] = repo.split('/')
    let page = 1
    const perPage = 100
    const mergedPRs = []
    const sinceDate = new Date(since)

    while (true) {
        const options = {
            hostname: 'api.github.com',
            path: `/repos/${owner}/${repoName}/pulls?state=closed&base=${baseBranch}&per_page=${perPage}&page=${page}`,
            headers: {
                'User-Agent': 'Node.js',
                Authorization: `token ${token}`,
                Accept: 'application/vnd.github+json',
            },
        }

        const prs = await new Promise((resolve, reject) => {
            https
                .get(options, (res) => {
                    let data = ''
                    res.on('data', (chunk) => (data += chunk))
                    res.on('end', () => {
                        if (res.statusCode !== 200) {
                            reject(
                                new Error(
                                    `GitHub API error ${res.statusCode}: ${data}`
                                )
                            )
                            return
                        }
                        try {
                            resolve(JSON.parse(data))
                        } catch (e) {
                            reject(e)
                        }
                    })
                })
                .on('error', reject)
        })

        if (!prs.length) break

        // Only include PRs that are actually merged and after the 'since' date
        const filteredMerged = prs.filter(
            (pr) => pr.merged_at && new Date(pr.merged_at) >= sinceDate
        )

        mergedPRs.push(...filteredMerged)

        // If all PRs returned are older than the since date or not merged, we can stop
        const hasMoreNewPRs = prs.some(
            (pr) => pr.merged_at && new Date(pr.merged_at) >= sinceDate
        )
        if (!hasMoreNewPRs || prs.length < perPage) break

        page++
    }

    return mergedPRs
}

/**
 * Determine bump type based on labels in PRs
 * major > minor > patch (default)
 * @param {Array} prs - array of PR objects
 * @returns {string} bump type
 */
function getBumpType(prs) {
    let bump = 'patch'
    for (const pr of prs) {
        const labels = pr.labels.map((l) => l.name.toLowerCase())
        if (labels.includes('major')) return 'major'
        if (labels.includes('minor')) bump = 'minor'
    }
    return bump
}

function formatBody(text) {
    let currentText = text
    if (text) {
        currentText = currentText.split('\r\n')
        const regex = /^\s*(?:[-*+•]|\d+\.|[a-zA-Z]\.)\s+(.*)$|^(.*)$/
        const result = currentText.map((lines) => {
            const match = lines.match(regex)
            const text = match[1] || match[2]
            return `    - ` + text
        })
        let formatted =  result.join('\r\n')
        if (currentText.length === 1) {
            formatted += '\r\n' // Add extra newline if input was a single line
        }
        return formatted
    }
    return ''
}


/**
 * Generate changelog markdown from grouped PRs and version
 * @param {string} version
 * @param {Object} groups
 * @returns {string} markdown changelog
 */
function generateChangelog(version, prs) {
    const date = new Date().toISOString().split('T')[0]
    let changelog = `## ${version}\n\n`
    changelog += '`' + date + '`'
    changelog += `\n\n`

    for (const pr of prs) {
        changelog += `- ${pr.title} ([#${pr.number}](${pr.html_url}))\n`
        if (pr.body) {
            changelog += `${formatBody(pr.body)}`
        }
    }

    return changelog
}

function getLastReleaseDateFromGit() {
    try {
        const tag =
            execSync('git tag --sort=-creatordate', { encoding: 'utf8' })
                .split('\n')
                .find(Boolean) || '0.0.0'
        const date = execSync(`git log -1 --format=%aI ${tag}`, {
            encoding: 'utf8',
        }).trim()
        console.log(`🕒 Last release tag: ${tag}, date: ${date}`)
        return date // ISO 8601 format
    } catch (err) {
        console.warn(
            '⚠️ No tags found or failed to get tag date. Using fallback date.'
        )
        return '1970-01-01'
    }
}

// Get latest tag name (e.g., v0.0.3)
function getLastTag() {
    try {
        const tag =
            execSync('git tag --sort=-creatordate', { encoding: 'utf8' })
                .split('\n')
                .find(Boolean) || '0.0.0'
        return tag
    } catch (e) {
        return '0.0.0'
    }
}

// Get the content of CHANGELOG.md from a specific tag
function getChangelogFromTag(tag) {
    try {
        return execSync(`git show ${tag}:CHANGELOG.md`).toString()
    } catch (e) {
        console.warn(`⚠️ Could not retrieve CHANGELOG.md from tag ${tag}`)
        return ''
    }
}

function getFileContentFromTag(tag, filePath) {
    try {
        return execSync(`git show ${tag}:${filePath}`, { encoding: 'utf8' })
    } catch {
        return '' // file doesn't exist in this tag
    }
}

/**
 * Get version string from latest tag
 * Checks package.json first, then version.txt
 */
function getVersionFromLatestTag() {
    try {
        const latestTag =
            execSync('git tag --sort=-creatordate', { encoding: 'utf8' })
                .split('\n')
                .find(Boolean) || '0.0.0'
        // Try package.json first
        let content = getFileContentFromTag(latestTag, 'package.json')
        if (content) {
            const pkg = JSON.parse(content)
            if (pkg.version) {
                return pkg.version
            }
        }

        // Fallback to version.txt
        content = getFileContentFromTag(latestTag, 'version.txt')
        if (content) {
            return content.trim()
        }

        return '0.0.0' // 0.0.0
    } catch (e) {
        console.warn('Could not get version from latest tag:', e.message)
        return null
    }
}

function fetchTags() {
    try {
        execSync('git fetch --tags', { stdio: 'inherit' })
        console.log('✅ Fetched latest tags from remote')
    } catch (e) {
        console.warn('⚠️ Failed to fetch tags:', e.message)
    }
}

module.exports = {
    fetchTags,
    versionBump,
    getCurrentVersion,
    updateVersion,
    fetchMergedPRs,
    getBumpType,
    generateChangelog,
    getLastReleaseDateFromGit,
    getLastTag,
    getChangelogFromTag,
    getVersionFromLatestTag,
}
