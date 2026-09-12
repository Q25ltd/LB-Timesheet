/**
 * The authenticated route group: its gate, and its navigation shell.
 *
 * THE GATE IS UNCHANGED and still wraps everything. `app/index.tsx` decides
 * the signed-out default for `/`, but it guards `/` alone; the app declares
 * `"scheme": "lbtimesheets"` (app.json), so a deep link could otherwise mount
 * an authenticated screen directly. Because the check lives here, above the
 * navigator, it covers every tab at once — no screen implements its own, and
 * a screen added later inherits it without its author remembering. Same
 * polarity as the API's default-deny route hook (F-10, D16): forgetting fails
 * CLOSED.
 *
 *   restoring        HOLD. A refresh credential may be mid-redemption, which
 *                    is a network round trip. Calling that "not signed in"
 *                    would bounce a signed-in driver through the password form.
 *   authenticated    render the tab shell.
 *   unauthenticated  REDIRECT. Never a placeholder — a signed-out driver must
 *                    land somewhere they can act.
 *
 * The navigator is only reached in the third case, so an unauthenticated
 * request never mounts a tab at all.
 *
 * `APP_TABS` supplies the destinations, and `AppTabBar` draws them: routing
 * stays the navigator's and the design stays ours.
 */
import { Redirect, Tabs } from "expo-router";
import { Restoring } from "../../src/components/Restoring";
import { AppTabBar } from "../../src/navigation/AppTabBar";
import { APP_TABS } from "../../src/navigation/tabs";
import { useAuth } from "../../src/auth/AuthContext";
import { colors } from "../../src/theme/index";

export default function AppLayout() {
  const { status } = useAuth();

  if (status === "restoring") return <Restoring />;
  if (status !== "authenticated") return <Redirect href="/sign-in" />;

  return (
    <Tabs
      screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: colors.background } }}
      tabBar={props => (
        <AppTabBar
          activeRouteName={props.state.routes[props.state.index]?.name ?? ""}
          onSelect={routeName => { props.navigation.navigate(routeName); }}
        />
      )}
    >
      {APP_TABS.map(tab => (
        <Tabs.Screen key={tab.name} name={tab.name} options={{ title: tab.label }} />
      ))}
    </Tabs>
  );
}
