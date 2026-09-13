/**
 * The four everyday destinations, and the bar that switches between them.
 *
 * This navigator holds ONLY the tabs. It is deliberately one level below the
 * authenticated group's Stack, so a screen can be placed BESIDE it rather than
 * inside it — which is how the Start Shift workflow gets to be free of the tab
 * bar without anything conditional, styled or route-name-sniffed.
 *
 * `APP_TABS` is the single source of truth this and `AppTabBar` both read, so a
 * control cannot point at a destination the app does not have.
 *
 * The authentication gate is NOT here. It lives once, in the parent
 * `(app)/_layout.tsx`, above this navigator and above the workflow alike.
 */
import { Tabs } from "expo-router";
import { AppTabBar } from "../../../src/navigation/AppTabBar";
import { APP_TABS } from "../../../src/navigation/tabs";
import { colors } from "../../../src/theme/index";

export default function TabsLayout() {
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
