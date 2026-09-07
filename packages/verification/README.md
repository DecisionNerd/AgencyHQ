# Verification package

Deterministic evaluators and evidence-bundle construction. Verifiers consume
exact contracts, artifacts, and Git identities and return structured
VerificationResults rather than mutating domain state.
Profiles are supervisor-approved and versioned outside worker write access.
Required review and supervisor acceptance remain coordinator decisions; a
VerificationResult does not by itself complete a Goal.
