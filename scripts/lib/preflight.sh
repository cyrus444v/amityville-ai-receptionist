# shellcheck shell=bash
#
# Preflight helpers for the CloudFormation-backed provisioning scripts.
#
# On 2 September 2026 scripts/provision-staging.sh deleted two live resources it
# was trying to preserve. Its preflight asked "does this resource exist in the
# account?" and, when the answer was yes, set the matching Create* parameter to
# 'no'. Both resources belonged to the ai-receptionist-staging stack itself, so
# 'no' dropped their CloudFormation condition and the update deleted them: the
# ECS cluster went INACTIVE ("The referenced cluster was inactive", the service
# rolled back) and the deploy role pointed at an OIDC provider that no longer
# existed ("The web identity token provided could not be validated").
#
# Existence is the wrong question. A Create* flag decides whether the stack
# declares the resource, so the question is "does this stack already own it?".
#
#   owned by this stack            -> yes  (no would delete it)
#   exists, owned by someone else  -> no   (adoption is impossible; legitimate)
#   does not exist                 -> yes
#   stack does not exist yet       -> falls out of the same rule: nothing is
#                                     owned, so the account decides
#
# The resolution is a pure function of those two booleans; everything that talks
# to AWS is kept in the cfn_* probes so it can be stubbed.

# cfn_stack_status REGION STACK
# Prints the stack status, or nothing when there is no such stack.
cfn_stack_status() {
  aws cloudformation describe-stacks --region "$1" --stack-name "$2" \
    --query 'Stacks[0].StackStatus' --output text 2>/dev/null || true
}

# cfn_stack_exists REGION STACK
# True only for a stack that can own resources. REVIEW_IN_PROGRESS is a change
# set that has never been executed and holds nothing; DELETE_COMPLETE is a
# tombstone that describe-stacks still answers for when queried by id.
cfn_stack_exists() {
  local status
  status="$(cfn_stack_status "$1" "$2")"
  case "$status" in
    '' | None | REVIEW_IN_PROGRESS | DELETE_COMPLETE) return 1 ;;
    *) return 0 ;;
  esac
}

# cfn_stack_owns REGION STACK LOGICAL_ID
# True when the stack currently manages that logical resource. A resource whose
# condition is already false is simply absent from the stack, which is what
# makes this the right question to ask.
cfn_stack_owns() {
  local status
  status="$(aws cloudformation describe-stack-resources --region "$1" \
    --stack-name "$2" --logical-resource-id "$3" \
    --query 'StackResources[0].ResourceStatus' --output text 2>/dev/null || true)"
  case "$status" in
    '' | None | DELETE_COMPLETE | DELETE_IN_PROGRESS | DELETE_FAILED) return 1 ;;
    *) return 0 ;;
  esac
}

# ecs_cluster_is_active REGION CLUSTER
# ECS keeps a deleted cluster queryable as INACTIVE, so describe-clusters
# answering at all proves nothing. Only ACTIVE counts as "this cluster exists";
# reading INACTIVE as existing is exactly the false alarm that started the
# incident above.
ecs_cluster_is_active() {
  local status
  status="$(aws ecs describe-clusters --region "$1" --clusters "$2" \
    --query 'clusters[0].status' --output text 2>/dev/null || true)"
  [ "$status" = ACTIVE ]
}

# iam_github_oidc_provider_exists
# GitHub's OIDC provider is account-global; creating it twice fails the stack.
iam_github_oidc_provider_exists() {
  aws iam list-open-id-connect-providers \
    --query "OpenIDConnectProviderList[?contains(Arn, 'token.actions.githubusercontent.com')]" \
    --output text 2>/dev/null | grep -q .
}

# resolve_create_flag OWNED_BY_STACK EXISTS_IN_ACCOUNT -> yes|no
# The whole decision, with no I/O. Ownership wins over existence, because a
# resource the stack owns is also a resource that exists — and answering 'no'
# for it is the deletion.
resolve_create_flag() {
  local owned="$1" exists="$2"
  if [ "$owned" = yes ]; then
    printf 'yes\n'
  elif [ "$exists" = yes ]; then
    printf 'no\n'
  else
    printf 'yes\n'
  fi
}

# explain_create_flag OWNED_BY_STACK EXISTS_IN_ACCOUNT STACK -> reason
explain_create_flag() {
  local owned="$1" exists="$2" stack="$3"
  if [ "$owned" = yes ]; then
    printf 'stack %s owns it — keeping it\n' "$stack"
  elif [ "$exists" = yes ]; then
    printf 'exists outside the stack — cannot be adopted\n'
  else
    printf 'does not exist yet\n'
  fi
}

# assert_flag_keeps_owned PARAMETER OWNED_BY_STACK FLAG STACK
# Last line of defence. Any path that would hand CloudFormation 'no' for a
# resource the stack still owns — an operator override, a future edit to the
# resolution — is a delete, and must stop the run loudly rather than deploy.
assert_flag_keeps_owned() {
  local parameter="$1" owned="$2" flag="$3" stack="$4"
  [ "$owned" = yes ] && [ "$flag" = no ] || return 0
  cat >&2 <<MSG

ERROR: refusing to deploy — ${parameter}=no would delete a live resource.

  Stack ${stack} currently owns the resource behind ${parameter}. Setting that
  parameter to 'no' removes its CloudFormation condition, and the next stack
  update deletes the resource. That is how the ECS cluster and the GitHub OIDC
  provider were destroyed on 2 September 2026.

  If the resource really should leave this stack, retire it deliberately —
  never as a side effect of a preflight flag.
MSG
  return 1
}
