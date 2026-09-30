import { usePageTitle } from "../usePageTitle";
import { DriverExperience } from "./home/DriverExperience";
import { FinalCta } from "./home/FinalCta";
import { ForCompanies } from "./home/ForCompanies";
import { Hero } from "./home/Hero";
import { HowItWorks } from "./home/HowItWorks";
import { PaperComparison } from "./home/PaperComparison";
import { Principles } from "./home/Principles";
import "../styles/home.css";

export function HomePage() {
  usePageTitle(null);
  return (
    <>
      <Hero />
      <Principles />
      <HowItWorks />
      <PaperComparison />
      <DriverExperience />
      <ForCompanies />
      <FinalCta />
    </>
  );
}
