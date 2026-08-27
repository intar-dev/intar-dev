import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { TooltipProvider } from "@/components/ui/tooltip";
import { appQueryClient } from "@/lib/app-bootstrap";
import { router } from "./router";
import { ThemeProvider } from "./theme";

export default function App() {
  return (
    <QueryClientProvider client={appQueryClient}>
      <ThemeProvider>
        <TooltipProvider>
          <RouterProvider router={router} />
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
