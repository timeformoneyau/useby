# One-off setup: only you can do these

Do them in order. About 20 minutes in total. Nothing here needs repeating
unless a token is lost or revoked.

Tick each box as you go. Steps 1–4 are needed before the first release
works; steps 5–9 make it safe and quiet.

---

### ☐ 1. Confirm your Expo username

1. Go to **expo.dev** and sign in.
2. Click your avatar. Your username is shown there.
3. Click **Projects**. Check there is a project called **useby**.

The app is currently set to the username **`mjreardno62`**. If yours is
different (for example `mjreardon62`), or there is no `useby` project, tell
Claude before going further. Releases fail with a permissions error until
this matches.

### ☐ 2. Create an Expo access token

This lets GitHub publish on your behalf without you logging in.

1. On **expo.dev**, click your avatar → **Account settings** → **Access tokens**.
2. Click **Create token**. Name it `github-actions`.
3. Copy the token. Expo shows it only once. Don't paste it into chat or a file.

### ☐ 3. Store the token in GitHub

**In the browser:**

1. Go to **github.com/timeformoneyau/useby** → **Settings** → **Secrets and variables** → **Actions**.
2. Click **New repository secret**.
3. Name: `EXPO_TOKEN`. Secret: paste the token. Click **Add secret**.

**Or in PowerShell:**

```powershell
winget install GitHub.cli          # skip if already installed
gh auth login                      # GitHub.com → HTTPS → log in with a browser
gh secret set EXPO_TOKEN --repo timeformoneyau/useby
# paste the token when asked, then press Enter
```

### ☐ 4. Check the scanner key is set on EAS

Without it, scanning in the released app says it isn't set up. A release
refuses to publish if it's missing, so you'll find out either way.

1. On **expo.dev** → **Projects** → **useby** → **Environment variables**.
2. Look for **`EXPO_PUBLIC_USEBY_PROXY_SECRET`** with both **Preview** and
   **Production** ticked. If it's there for both, you're done with this step.
3. If not, click **Add variable**:
   - **Name:** `EXPO_PUBLIC_USEBY_PROXY_SECRET`
   - **Value:** the proxy's `MOBILE_APP_SECRET`. Find it in **Vercel** →
     **usebyproxy** project → **Settings** → **Environment Variables**.
   - **Environments:** tick **Preview** and **Production**.
   - **Visibility:** **Sensitive**. Not *Secret*: a *Secret* value can't be
     read when an update is published, so the update would ship without it.
   - Save.

Leave `EXPO_PUBLIC_USEBY_PROXY_URL` unset unless you deliberately want to
point at a different proxy. If you do set it, give Preview and Production the
same value: a production promotion reuses the preview update exactly,
settings included.

**Or in PowerShell**, from the project folder:

```powershell
npx eas-cli login
npx eas-cli env:create --environment preview --environment production --name EXPO_PUBLIC_USEBY_PROXY_SECRET --value "PASTE-HERE" --visibility sensitive
```

### ☐ 5. Let tested changes merge themselves

1. GitHub repo → **Settings** → **General**. Scroll to **Pull Requests**.
2. Tick **Allow auto-merge**. Optionally also tick **Automatically delete head branches**.

### ☐ 6. Only let tested changes into `main`

1. GitHub repo → **Settings** → **Rules** → **Rulesets** → **New ruleset** → **New branch ruleset**.
2. **Ruleset name:** `main`. **Enforcement status:** Active.
3. **Target branches:** **Add target** → **Include default branch**.
4. Tick **Require a pull request before merging**. Set required approvals to **0**,
   so auto-merge can go ahead once the tests pass.
5. Tick **Require status checks to pass** → **Add checks** → add **`checks`**
   and **`flow-tests`**.
6. Leave **Block force pushes** ticked. Click **Create**.

Without this, auto-merge would merge a change before its tests finish.

### ☐ 7. The production approval gate

1. GitHub repo → **Settings** → **Environments** → **New environment**. Name it `production`.
2. Tick **Required reviewers** and add **timeformoneyau** (you). Leave
   **Prevent self-review** unticked.
3. Under **Deployment branches and tags**, choose **Selected branches and
   tags** and add `main`.
4. Click **Save protection rules**.

### ☐ 8. Get the approval as a push notification

1. Install **GitHub** from the Play Store and sign in.
2. In the app: your profile → ⚙ **Settings** → **Notifications**. Turn on
   **Deployment reviews**.
3. Optional, on github.com: avatar → **Settings** → **Notifications** →
   **Actions** → **Only notify for failed workflows**. You then hear about
   failures and nothing else.

### ☐ 9. Block leaked keys at the door

1. GitHub repo → **Settings** → **Advanced Security**. In some layouts it's
   called **Code security**.
2. Enable **Secret Protection** and **Push protection**. If they already say
   *Enabled*, leave them. They're free on public repos.

GitHub will then refuse any push that contains a recognisable key. CI also
scans every commit for secrets on top of this.

---

## After the first merge

The first release finds no installed-app build for this version, so it builds
one. That takes 10–60 minutes on the free tier, depending on the queue. When
it's done:

1. A GitHub issue appears: **"New UseBy app to install"**.
2. Open it on your phone and tap the download link.
3. If Android says the app conflicts with an existing one, uninstall the old
   UseBy first. The new build is signed with a different key. You said there's
   no data to keep.
4. Close the issue.

From then on, most changes arrive as the **"New version ready"** banner.
