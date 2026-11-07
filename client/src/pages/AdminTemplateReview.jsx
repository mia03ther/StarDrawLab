import { Navigate } from "react-router-dom";

// Keep existing admin bookmarks working after publication becomes immediate.
const AdminTemplateReview = () => <Navigate to="/ai/template-studio?manage=all" replace />;

export default AdminTemplateReview;
