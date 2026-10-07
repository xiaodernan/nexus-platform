package com.nexus.merchant;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.nexus.platform.ApiException;
import com.nexus.platform.RequiresPermission;
import com.nexus.platform.TenantContext;
import com.nexus.platform.WorkspaceAccess;
import com.nexus.testsupport.NexusIntegrationTest;
import java.util.ArrayList;
import java.util.List;
import java.util.TreeSet;
import java.util.UUID;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerMapping;

/**
 * The check that would have caught D42 without anybody having to open the demo: a route that guards a
 * permission no preset can hand out answers 403 forever, and nothing else in the build notices.
 *
 * <p>Both tests read the permissions off the handler methods Spring registered rather than grepping the
 * sources, because the same claim is written two ways in this codebase — {@code value = "read_analytics"} and
 * {@code value = MerchantPermissions.READ_ANALYTICS} — and only the evaluated annotation says what the
 * interceptor will compare. That is also why this is a test and not a {@code quality.sql} row: the vocabulary
 * lives in Java, and a SQL check could only re-derive it by hand-copying the list, which is how a second
 * source of truth gets made (D42's rule about printing one value from two places).
 */
class PermissionVocabularyTest extends NexusIntegrationTest {

    @Autowired
    private RequestMappingHandlerMapping mappings;

    @Autowired
    private WorkspaceAccess workspace;

    @Test
    @DisplayName("Every permission a served route guards is one a role preset or an API key can be given")
    void enforcedPermissionsAreAllGrantable() {
        TreeSet<String> enforced = new TreeSet<>();
        for (HandlerMethod handler : mappings.getHandlerMethods().values()) {
            RequiresPermission declared = declaredOn(handler);
            if (declared != null && !declared.value().isBlank()) {
                enforced.add(declared.value());
            }
        }

        // The guard that makes the line below mean something. Read against a router that registered nothing —
        // a failed component scan, a wrong profile, an exception earlier in this same run — `enforced` is empty,
        // `containsAll` passes, and the gate reports the vocabulary as sound. D41 learned the same trap from the
        // other side: a reconciliation against an empty set proves only that the set was empty. So the four
        // permissions D42 had to add for the demo to work at all are named here: they have to be observed.
        List<String> observed = new ArrayList<>(enforced);
        assertThat(observed).as("permissions guarded by the running router")
                .contains("admin_members", "configure_ai", "read_analytics", "send_message");

        TreeSet<String> grantable = new TreeSet<>();
        for (String role : MerchantPermissions.ROLES) {
            grantable.addAll(MerchantPermissions.defaultsForRole(role));
        }
        grantable.addAll(MerchantPermissions.API_KEY_SCOPES);

        // A permission outside that union cannot be written by any path in the service: `reconcileGrants` copies
        // a preset, `ApiKeyService.create` 422s an unknown scope, and the seed writes the owner preset. So the
        // route would compare its string against rows nobody can produce.
        assertThat(grantable).as("permissions any subject can hold").containsAll(enforced);
    }

    @Test
    @DisplayName("The machine subjects never hold the two human judgements — publishing a campaign and accepting a hold")
    void machineSubjectsNeverHoldTheHumanJudgements() {
        // MerchantPermissions' javadoc promises this; the promise is load-bearing (D26: a machine can
        // never decide a real evening, and AGENT_CONTRACT §8 keeps publish out of every machine
        // preset), so it is pinned against the constants the build actually grants from.
        List<String> judgements = List.of(MerchantPermissions.PUBLISH_CAMPAIGN,
                MerchantPermissions.MANAGE_RESERVATIONS);
        for (String judgement : judgements) {
            assertThat(MerchantPermissions.defaultsForRole("ai_agent"))
                    .as("the ai_agent preset must not carry " + judgement).doesNotContain(judgement);
            assertThat(MerchantPermissions.API_KEY_SCOPES)
                    .as("api-key scopes must not carry " + judgement).doesNotContain(judgement);
        }
        assertThat(MerchantPermissions.defaultsForRole("staff"))
                .as("staff may reserve on the guest's behalf but not accept a hold (D26)")
                .doesNotContain(MerchantPermissions.MANAGE_RESERVATIONS);
    }

    @Test
    @DisplayName("Every merchant() spelling on a guarded route is one the resolver actually understands")
    void merchantScopesResolveOrFailAsAClientError() {
        TenantContext tenant = new TenantContext(UUID.randomUUID(), "hong-kong", "HKD", "Asia/Hong_Kong", "HK");
        List<String> checked = new ArrayList<>();
        for (HandlerMethod handler : mappings.getHandlerMethods().values()) {
            RequiresPermission declared = declaredOn(handler);
            if (declared == null || declared.merchant().isBlank()) {
                continue;
            }
            checked.add(declared.merchant());
            // The request is deliberately empty, so the resolver reaches its own verdict about the spelling and
            // then fails on the missing id. What it must never do is answer 5xx: `WorkspaceAccess` throws
            // `internal` for a kind it does not handle, which turns a typo in an annotation into a 500 on a
            // route that looks served and documented from every other angle. The resolver is the source of
            // truth for which kinds exist, so this asserts against its behavior rather than against a copied
            // list of prefixes that would go stale the first time a new one is added.
            assertThatThrownBy(() -> workspace.resolveMerchantId(tenant, new MockHttpServletRequest(), handler,
                    declared.merchant()))
                    .as("merchant spec %s on %s#%s", declared.merchant(),
                            handler.getBeanType().getSimpleName(), handler.getMethod().getName())
                    .isInstanceOfSatisfying(ApiException.class,
                            failure -> assertThat(failure.status())
                                    .as("the spelling is understood, so only the absent id is refused")
                                    .isLessThan(500));
        }
        assertThat(checked).as("guarded routes with a merchant scope").isNotEmpty();
    }

    /** Where the interceptor looks, the gate looks: the method first, then the controller type. */
    private static RequiresPermission declaredOn(HandlerMethod handler) {
        RequiresPermission onMethod = handler.getMethodAnnotation(RequiresPermission.class);
        return onMethod != null ? onMethod : handler.getBeanType().getAnnotation(RequiresPermission.class);
    }
}
