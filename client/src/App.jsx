import VideoMaintenance from "./pages/VideoMaintenance";
import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import RoleGuard from "./components/RoleGuard";
import { Toaster } from "react-hot-toast";
import CustomerServiceQr from "./components/CustomerServiceQr";

const Landing = lazy(() => import("./pages/Landing"));
const AtelierLanding = lazy(() => import("./pages/AtelierLanding"));
const PhysicalCustomMvp = lazy(() => import("./pages/PhysicalCustomMvp"));
const AgentHome = lazy(() => import("./pages/AgentHome"));
const Layout = lazy(() => import("./pages/Layout"));
const Dashboard = lazy(() => import("./pages/Dashboard"));
const SceneImage = lazy(() => import("./pages/SceneImage"));
const AIVideo = lazy(() => import("./pages/AIVideo"));
const DigitalHuman = lazy(() => import("./pages/DigitalHuman"));
const History = lazy(() => import("./pages/History"));
const Billing = lazy(() => import("./pages/Billing"));
const Callback = lazy(() => import("./pages/Callback"));
const TemplateStudio = lazy(() => import("./pages/TemplateStudio"));
const TemplateMarketplace = lazy(() => import("./pages/TemplateMarketplace"));
const AccountCenter = lazy(() => import("./pages/AccountCenter"));
const CanvasStudio = lazy(() => import("./pages/CanvasStudio"));
const DigitalHumanRoleStudio = lazy(() => import("./pages/DigitalHumanRoleStudio"));
const DigitalHumanCapture = lazy(() => import("./pages/DigitalHumanCapture"));
const AdminSubscriptionPlans = lazy(() => import("./pages/AdminSubscriptionPlans"));
const AdminGenerationPricing = lazy(() => import("./pages/AdminGenerationPricing"));
const AdminTemplateReview = lazy(() => import("./pages/AdminTemplateReview"));
const AdminUsers = lazy(() => import("./pages/AdminUsers"));
const AdminAuditLogs = lazy(() => import("./pages/AdminAuditLogs"));
const AdminUsageAnalytics = lazy(() => import("./pages/AdminUsageAnalytics"));
const RecycleBin = lazy(() => import("./pages/RecycleBin"));
const AdminModels = lazy(() => import("./pages/AdminModels"));
const AdminRecycleBin = lazy(() => import("./pages/AdminRecycleBin"));
const RootPrivateContentReview = lazy(() => import("./pages/RootPrivateContentReview"));
const McpConnections = lazy(() => import("./pages/McpConnections"));
const AdminMcpConsole = lazy(() => import("./pages/AdminMcpConsole"));
const AdminVisualParameters = lazy(() => import("./pages/AdminVisualParameters"));
const TaskCenter = lazy(() => import("./pages/TaskCenter"));
const CommunityCreation = lazy(() => import("./pages/CommunityCreation"));
const AdminSkills = lazy(() => import("./pages/AdminSkills"));
const InviteLanding = lazy(() => import("./pages/InviteLanding"));
const Invitations = lazy(() => import("./pages/Invitations"));
const AdminInvitations = lazy(() => import("./pages/AdminInvitations"));
const AdminAnnouncements = lazy(() => import("./pages/AdminAnnouncements"));

const USER_ROLES = ["user", "admin", "root"];
const ADMIN_ROLES = ["admin", "root"];
const ROOT_ROLES = ["root"];
const TASK_CENTER_ENABLED = import.meta.env.VITE_FEATURE_TASK_CENTER === "true";

const PageFallback = () => (
  <div
    role="status"
    aria-label="加载中"
    className="flex min-h-screen items-center justify-center"
    style={{ background: "var(--sd-page, #f7f5ef)", color: "var(--sd-muted, #69675f)" }}
  >
    <span className="h-7 w-7 animate-spin rounded-full border-2 border-current border-t-transparent" />
  </div>
);

const App = () => {
  return (
    <div>
      <Toaster
        position="bottom-right"
        containerStyle={{ bottom: "84px", right: "20px" }}
        toastOptions={{
          style: {
            background: "#1c2026",
            color: "#dfe2eb",
            border: "1px solid rgba(69,71,75,0.35)",
            fontFamily: "Inter, sans-serif",
            fontSize: "13px",
          },
          success: { iconTheme: { primary: "#ee9d47", secondary: "#2b1708" } },
          error:   { iconTheme: { primary: "#ffb4ab", secondary: "#690005" } },
        }}
      />
      <CustomerServiceQr />
      <Suspense fallback={<PageFallback />}>
      <Routes>
        {/* Keep the established creation dashboard as the default product home.
            The physical-design MVP is intentionally isolated behind its own entry. */}
        <Route path="/" element={<Landing />} />
        <Route path="/design" element={<PhysicalCustomMvp />} />
        <Route path="/custom" element={<Navigate to="/design" replace />} />
        <Route path="/design/landing" element={<AtelierLanding />} />
        {/* Keep the legacy URL usable while the community feed lives on the home page. */}
        <Route path="/discover" element={<Navigate to="/home#community" replace />} />
        <Route
          path="/home"
          element={(
            <RoleGuard allowedRoles={USER_ROLES}>
              <AgentHome />
            </RoleGuard>
          )}
        />
        <Route path="/community/creation/:creationId" element={<CommunityCreation />} />
        <Route path="/invite" element={<InviteLanding />} />
        <Route path="/callback" element={<Callback />} />
        <Route path="/capture/digital-human/:token" element={<DigitalHumanCapture />} />
        <Route path="/ai" element={<Layout />}>
          <Route element={<RoleGuard allowedRoles={USER_ROLES} />}>
            <Route index element={<Dashboard />} />
            <Route path="scene-image" element={<SceneImage />} />
            <Route path="ai-video" element={import.meta.env.VITE_VIDEO_GENERATION_ENABLED === "false" ? <VideoMaintenance /> : <AIVideo />} />
            <Route path="digital-human" element={import.meta.env.VITE_VIDEO_GENERATION_ENABLED === "false" ? <VideoMaintenance /> : <DigitalHuman />} />
            <Route path="digital-human-roles" element={<DigitalHumanRoleStudio />} />
            <Route path="canvas" element={<CanvasStudio />} />
            <Route path="agent" element={<Navigate to="/home" replace />} />
            <Route path="mcp" element={<McpConnections />} />
            <Route path="template-studio" element={<TemplateStudio />} />
            <Route path="templates" element={<TemplateMarketplace />} />
            <Route path="templates/:templateId" element={<TemplateMarketplace />} />
            <Route path="account" element={<AccountCenter />} />
            <Route path="invitations" element={<Invitations />} />
            <Route path="announcements" element={<Navigate to="/home" replace />} />
            <Route path="history" element={<History />} />
            <Route path="tasks" element={TASK_CENTER_ENABLED ? <TaskCenter /> : <Navigate to="/ai" replace />} />
            <Route path="billing" element={<Billing />} />
            <Route path="recycle-bin" element={<RecycleBin />} />
          </Route>

          <Route element={<RoleGuard allowedRoles={ADMIN_ROLES} />}>
            <Route path="admin/users" element={<AdminUsers />} />
            <Route path="admin/subscriptions" element={<AdminSubscriptionPlans />} />
            <Route path="admin/pricing" element={<AdminGenerationPricing />} />
            <Route path="admin/template-review" element={<AdminTemplateReview />} />
            <Route path="admin/recycle-bin" element={<AdminRecycleBin />} />
            <Route path="admin/mcp" element={<AdminMcpConsole />} />
            <Route path="admin/visual-parameters" element={<AdminVisualParameters />} />
            <Route path="admin/agent-skills" element={<AdminSkills />} />
            <Route path="admin/invitations" element={<AdminInvitations />} />
            <Route path="admin/announcements" element={<AdminAnnouncements />} />
          </Route>

          <Route element={<RoleGuard allowedRoles={ROOT_ROLES} />}>
            <Route path="admin/roles" element={<AdminUsers roleManagementOnly />} />
            <Route path="admin/models" element={<AdminModels mode="catalog" />} />
            <Route path="admin/model-routing" element={<AdminModels mode="routing" />} />
            <Route path="admin/audit-logs" element={<AdminAuditLogs />} />
            <Route path="admin/usage-analytics" element={<AdminUsageAnalytics />} />
            <Route path="admin/private-content-review" element={<RootPrivateContentReview />} />
          </Route>
        </Route>
      </Routes>
      </Suspense>
    </div>
  );
};

export default App;
