# Backup import

Local backup restore requires explicit native overwrite consent before running the Agent's noninteractive import command.

[[src/main/installer.ts#runHermesImport]] validates the archive and installation, captures the target profile, and asks before replacing configuration, credentials, sessions or other backup contents. Provider backups may also restore external files. The main IPC handler parents the warning to the app window. Archive-content validation and restore rules remain owned by the Agent.

## Explicit overwrite consent

Cancel is the default native choice and returns without starting a child or writing configuration; unavailable dialogs also fail safely.

## Approved noninteractive restore

After consent, the command uses the validated captured profile and archive as separate arguments with `--force`, avoiding the Agent's stdin prompt in a desktop subprocess.

Default is passed explicitly to prevent later sticky-profile selection from retargeting the restore.

## Local target isolation

Remote and SSH selections cannot silently restore local data; after consent, the operation cancels if the current connection is no longer Local.

Switching between Local records does not retarget the approved profile: the restore always uses the profile captured before confirmation.

The mode is checked before and after the warning; the operation does not record intervening connection switches.

## CLI failure diagnostics

Failed imports preserve ANSI-stripped stderr or stdout diagnostics before falling back to the process error, so archive-validation errors stay visible.

[[tests/backup-import-consent.test.ts]] uses disposable files and a stubbed process/dialog boundary. No real archive, user configuration or native restore is exercised.
