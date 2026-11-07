import { useNavigate } from "react-router-dom";
import { assets } from "../assets/assets";
import { ArrowRight } from "lucide-react";
import { useAuthing } from "../contexts/AuthingContext";

const Navbar = () => {
  const navigate = useNavigate();
  const { isSignedIn, user, login, logout } = useAuthing();

  return (
    <div className="fixed inset-x-0 top-0 z-10 border-b border-white/10 bg-black/30 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 sm:px-8">
        <button
          onClick={() => navigate("/")}
          className="qa-btn qa-btn-ghost px-2"
          type="button"
        >
          <span className="rounded-md bg-white/90 px-2 py-1">
            <img src={assets.logo} alt="logo" className="w-32 sm:w-40" />
          </span>
        </button>

        {isSignedIn ? (
          <div className="flex items-center gap-4">
            <button
              onClick={() => navigate("/ai")}
              className="hidden text-sm font-medium text-slate-200 transition hover:text-white sm:block"
            >
              Workspace
            </button>
            {user?.imageUrl ? (
              <img
                src={user.imageUrl}
                alt={user.name}
                className="h-8 w-8 rounded-full ring-1 ring-white/20 cursor-pointer"
                onClick={() => logout()}
              />
            ) : (
              <div
                className="h-8 w-8 rounded-full bg-primary/40 flex items-center justify-center text-xs text-white cursor-pointer ring-1 ring-white/20"
                onClick={() => logout()}
              >
                {user?.name?.[0]?.toUpperCase() || "U"}
              </div>
            )}
          </div>
        ) : (
          <button
            onClick={() => login()}
            className="qa-btn qa-btn-primary"
            type="button"
          >
            Get started <ArrowRight className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
};

export default Navbar;
