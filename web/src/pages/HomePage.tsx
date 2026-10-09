import { usePageTitle } from "../usePageTitle";
import { DriverExperience } from "./home/DriverExperience";
import { FinalCta } from "./home/FinalCta";
import { ForCompanies } from "./home/ForCompanies";
import { Hero } from "./home/Hero";
import { HowItWorks } from "./home/HowItWorks";
import { PaperComparison } from "./home/PaperComparison";
import { PortalAndApp } from "./home/PortalAndApp";
import { Statement } from "./home/Statement";
import "../styles/home.css";

export function HomePage() {
  usePageTitle(null);
  return (
    <>
      <Hero />
      <PaperComparison />
      <HowItWorks />
      <Statement />
      <DriverExperience />
      <PortalAndApp />
      <ForCompanies />
      <FinalCta />
    </>
  );
}
