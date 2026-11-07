import { assets } from "../assets/assets";
import { useLanguage } from "../contexts/LanguageContext";

const Testimonial = () => {
  const { t } = useLanguage();
  const dummyTestimonialData = [
    {
      image:
        "https://images.unsplash.com/photo-1633332755192-727a05c4013d?q=80&w=200",
      name: "John Doe",
      title: "Marketing Director, TechCorp",
      content:
        "ContentAI has revolutionized our content workflow. The quality of the articles is outstanding, and it saves us hours of work every week.",
      rating: 4,
    },
    {
      image:
        "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?q=80&w=200",
      name: "Jane Smith",
      title: "Content Creator, TechCorp",
      content:
        "ContentAI has made our content creation process effortless. The AI tools have helped us produce high-quality content faster than ever before.",
      rating: 5,
    },
    {
      image:
        "https://images.unsplash.com/photo-1438761681033-6461ffad8d80?q=80&w=200&h=200&auto=format&fit=crop",
      name: "David Lee",
      title: "Content Writer, TechCorp",
      content:
        "ContentAI has transformed our content creation process. The AI tools have helped us produce high-quality content faster than ever before.",
      rating: 4,
    },
  ];

  return (
    <div className="mx-auto max-w-6xl px-4 py-20 sm:px-8">
      <div className="text-center">
        <h2 className="text-3xl font-semibold text-slate-100 sm:text-4xl">{t("用户反馈", "Feedback")}</h2>
        <p className="qa-muted mx-auto mt-3 max-w-lg text-sm leading-6">
          {t("听听团队在更快交付作品后的真实感受。", "What teams say after shipping assets faster.")}
        </p>
      </div>
      <div className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-3">
        {dummyTestimonialData.map((testimonial, index) => (
          <div
            key={index}
            className="qa-card qa-card-hover p-6"
          >
            <div className="flex items-center gap-1">
              {Array(5)
                .fill(0)
                .map((_, index) => (
                  <img
                    key={index}
                    src={
                      index < testimonial.rating
                        ? assets.star_icon
                        : assets.star_dull_icon
                    }
                    alt="star"
                    className="h-4 w-4 opacity-90"
                  />
                ))}
            </div>
            <p className="qa-muted my-5 text-sm leading-6">
              "{testimonial.content}"
            </p>
            <hr className="mb-5 border-white/10" />
            <div className="flex items-center gap-4">
              <img
                src={testimonial.image}
                className="w-12 rounded-full object-contain ring-1 ring-white/10"
                alt=""
              />
              <div className="text-sm">
                <h3 className="font-medium text-slate-100">{testimonial.name}</h3>
                <p className="qa-muted text-xs">{testimonial.title}</p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default Testimonial;
