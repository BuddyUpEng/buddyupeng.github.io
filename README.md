# Buddysco.com

#### Hugo installation and running the website locally
1. Install hugo using the [Hugo installation guide](https://gohugo.io/getting-started/installing/)
2. Clone this repository
```
git clone git@github.com:BuddyUpEng/buddyupeng.github.io.git
```
3. Open terminal in the repositories directory and run the following to start the website
```
hugo server -D
```

#### How to add a blog 
1. To add a blog you need to create a markdown ( blog-file.md ) file in `content/blog' directory. 
2. For example to create a blog with title "Amazing Blog Title", with a feature image stored in the repository at `static/images/allpost/allPost-7.jpg`, tags as ['productivity', 'study group'] and content as 'amazing content', you need to add a markdown file at `content/blog/amazing-blog.md` with the following content.
```
---
title: "Amazing Blog title"
date: 2020-07-13T12:00:00+06:00
featureImage: images/allpost/allPost-7.jpg
postImage: images/single-blog/feature-image.jpg
tags: ['productivity', 'study group']
categories: blog
---

amazing content
```

#### Hugo Website Creation steps
```
hugo new site buddysco.com
cd buddysco.com
git init
git submodule add git@github.com:StaticMania/portio-hugo.git themes/portio
cp -r themes/portio/exampleSite/* ./
hugo server -t portio
```

### Hugo Github pages deployment
Follow the steps mentioned [here](https://gohugo.io/hosting-and-deployment/hosting-on-github/).

## Account deletion, support and community pages

`static/delete-account/` is a standalone page so sign-in does not load the theme’s analytics or contact-form scripts. It uses Firebase JS 12.19.0 with in-memory authentication and the production web registration from the app. `deletion-core.mjs` contains the owner/confirmation/retry state machine; its injected test transport cannot be selected by a URL or browser flag in the shipped page. No credentials or generated site output should be committed.

```sh
node --test tests/*.test.mjs
# Use the pinned Hugo 0.91.2 from the workflow; write output outside the checkout.
hugo --minify --destination /absolute/path/to/local-site-output
```

Before publishing, deploy and accept `requestAccountDeletion` plus its worker and account-fence rules together. Verify `buddysco.com` (and `www.buddysco.com` if served) in production Firebase Auth authorized domains, existing email/password and phone sign-in providers, and phone SMS region policy. Never enable a test-auth bypass to exercise deletion. Test real service integration only with specifically authorized synthetic accounts; unit tests do not establish live SMS or deletion-worker completion.

Firebase [phone sign-in creates an Auth record when none exists](https://docs.cloud.google.com/identity-platform/docs/reference/rest/v1/accounts/signInWithPhoneNumber); it has no supported existing-account-only flag. After phone ownership verification, the page checks [`getAdditionalUserInfo(result).isNewUser`](https://firebase.google.com/docs/reference/js/auth.additionaluserinfo). Only existing users reach the app-deletion checkbox. A new verification-only record is immediately rolled back with Firebase `deleteUser` against that exact new User, without calling the app-deletion endpoint. UID/object and generation guards prevent a changed account from being removed or signed out. An uncertain cleanup keeps a guarded retry and support instructions; it never claims removal succeeded. This works without depending on the project-wide signup-disable setting. There is no pre-verification account enumeration.

The callable accepts exactly `{expectedUid, operationId, confirmed: true}` in `us-central1` and returns `{status: 'deleting' | 'complete', requestId}`. The first dispatch refreshes its ID token after interactive sign-in. A recent-login-required response asks the user to sign in again and retains the operation UUID in this tab. An uncertain retry keeps the same UUID and can use the existing valid ID token after account disabling; no new request is started. Auth changes invalidate pending responses, including an A-to-B-to-A switch. Accepted requests sign out; a failed local sign-out does not undo acceptance. Closing/reloading clears the in-memory sign-in and retry state. The backend recognizes an already recorded request for the same verified account.

`/support/`, `/delete-account/` and `/community-guidelines/` are public static resources. Community guidelines version `2026-10-17` matches the app acknowledgement. Keep deletion and retention wording aligned with the backend’s `learning/ACCOUNT_DELETION.md`; do not promise a completion or support-response SLA. Publishing/merging the branch is a separate release action.
